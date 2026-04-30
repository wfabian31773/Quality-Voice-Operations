// Shape-detected parser for SES (SNS-wrapped + direct), Postmark,
// SendGrid, and Mailgun delivery webhooks. Sibling to bounceWebhookParser
// but covers delivered/spam/dropped/deferred too. Unknown shapes return
// [] so the route can 202 and the provider stops retrying.

export type EmailDeliveryEventStatus =
  | 'delivered'
  | 'bounced'
  | 'spam'
  | 'dropped'
  | 'deferred';

export interface ParsedEmailDeliveryEvent {
  recipientEmail: string;
  messageId: string | null;
  status: EmailDeliveryEventStatus;
  error: string | null;
  provider: 'ses' | 'postmark' | 'sendgrid' | 'mailgun' | 'unknown';
}

function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// Canonical Message-ID form for storage and webhook lookup: trimmed,
// with surrounding angle brackets removed. Idempotent. Both the
// SyncErrorAlerter (when capturing the outbound id from sendEmail()) and
// the webhook parsers funnel through this so a stored
// `<abc@host>` matches a webhook-reported `<abc@host>` or `abc@host`.
export function normaliseMessageId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let v = value.trim();
  if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1).trim();
  return v.length > 0 ? v : null;
}

function parseSesPayload(payload: Record<string, unknown>): ParsedEmailDeliveryEvent[] {
  let inner: Record<string, unknown> | null = payload;
  if (payload.Type === 'Notification' && typeof payload.Message === 'string') {
    try {
      inner = asObject(JSON.parse(payload.Message));
    } catch {
      return [];
    }
  }
  if (!inner) return [];

  const notificationType =
    asString(inner.notificationType) ?? asString(inner.eventType);
  if (!notificationType) return [];

  const mail = asObject(inner.mail) ?? {};
  const messageId = normaliseMessageId(mail.messageId);

  if (notificationType === 'Delivery') {
    const delivery = asObject(inner.delivery);
    const recipients = Array.isArray(delivery?.recipients)
      ? (delivery!.recipients as unknown[])
      : Array.isArray(mail.destination)
        ? (mail.destination as unknown[])
        : [];
    return recipients
      .map((r) => normaliseEmail(r))
      .filter((e): e is string => e !== null)
      .map((email) => ({
        recipientEmail: email,
        messageId,
        status: 'delivered' as const,
        error: null,
        provider: 'ses' as const,
      }));
  }

  if (notificationType === 'Bounce') {
    const bounce = asObject(inner.bounce);
    if (!bounce) return [];
    if (asString(bounce.bounceType) !== 'Permanent') return [];
    const recipients = Array.isArray(bounce.bouncedRecipients)
      ? (bounce.bouncedRecipients as unknown[])
      : [];
    const events: ParsedEmailDeliveryEvent[] = [];
    for (const r of recipients) {
      const obj = asObject(r);
      if (!obj) continue;
      const email = normaliseEmail(obj.emailAddress);
      if (!email) continue;
      const diag =
        asString(obj.diagnosticCode) ??
        asString(bounce.bounceSubType) ??
        'SES permanent bounce';
      events.push({
        recipientEmail: email,
        messageId,
        status: 'bounced',
        error: diag,
        provider: 'ses',
      });
    }
    return events;
  }

  if (notificationType === 'Complaint') {
    const complaint = asObject(inner.complaint);
    const recipients = Array.isArray(complaint?.complainedRecipients)
      ? (complaint!.complainedRecipients as unknown[])
      : [];
    const events: ParsedEmailDeliveryEvent[] = [];
    for (const r of recipients) {
      const obj = asObject(r);
      if (!obj) continue;
      const email = normaliseEmail(obj.emailAddress);
      if (!email) continue;
      const diag =
        asString(complaint?.complaintFeedbackType) ?? 'SES complaint';
      events.push({
        recipientEmail: email,
        messageId,
        status: 'spam',
        error: diag,
        provider: 'ses',
      });
    }
    return events;
  }

  return [];
}

const POSTMARK_HARD_BOUNCE_TYPES = new Set([
  'HardBounce',
  'BadEmailAddress',
  'ManuallyDeactivated',
  'Unknown',
  'Blocked',
]);

function parsePostmarkPayload(payload: Record<string, unknown>): ParsedEmailDeliveryEvent[] {
  const recordType = asString(payload.RecordType);
  if (!recordType) return [];
  const email = normaliseEmail(payload.Email ?? payload.EmailAddress ?? payload.Recipient);
  if (!email) return [];
  const messageId = normaliseMessageId(payload.MessageID);

  if (recordType === 'Delivery') {
    return [
      {
        recipientEmail: email,
        messageId,
        status: 'delivered',
        error: null,
        provider: 'postmark',
      },
    ];
  }

  if (recordType === 'Bounce') {
    const type = asString(payload.Type);
    if (!type || !POSTMARK_HARD_BOUNCE_TYPES.has(type)) return [];
    const error =
      asString(payload.Description) ??
      asString(payload.Details) ??
      `Postmark ${type}`;
    return [
      {
        recipientEmail: email,
        messageId,
        status: 'bounced',
        error,
        provider: 'postmark',
      },
    ];
  }

  if (recordType === 'SpamComplaint') {
    return [
      {
        recipientEmail: email,
        messageId,
        status: 'spam',
        error: asString(payload.Description) ?? 'Postmark spam complaint',
        provider: 'postmark',
      },
    ];
  }

  return [];
}

function parseSendGridPayload(payloadList: unknown[]): ParsedEmailDeliveryEvent[] {
  const events: ParsedEmailDeliveryEvent[] = [];
  for (const raw of payloadList) {
    const obj = asObject(raw);
    if (!obj) continue;
    const event = asString(obj.event);
    if (!event) continue;
    const email = normaliseEmail(obj.email);
    if (!email) continue;
    // smtp-id is the original Message-ID we stored at send time; prefer
    // it over SendGrid's internal sg_message_id.
    const messageId =
      normaliseMessageId(obj['smtp-id']) ?? normaliseMessageId(obj.sg_message_id);

    if (event === 'delivered') {
      events.push({
        recipientEmail: email,
        messageId,
        status: 'delivered',
        error: null,
        provider: 'sendgrid',
      });
      continue;
    }
    if (event === 'spamreport') {
      events.push({
        recipientEmail: email,
        messageId,
        status: 'spam',
        error: asString(obj.reason) ?? 'SendGrid spam report',
        provider: 'sendgrid',
      });
      continue;
    }
    if (event === 'deferred') {
      events.push({
        recipientEmail: email,
        messageId,
        status: 'deferred',
        error: asString(obj.response) ?? asString(obj.reason) ?? 'SendGrid deferred',
        provider: 'sendgrid',
      });
      continue;
    }
    if (event === 'bounce' && asString(obj.type) === 'bounce') {
      events.push({
        recipientEmail: email,
        messageId,
        status: 'bounced',
        error: asString(obj.reason) ?? asString(obj.response) ?? 'SendGrid bounce',
        provider: 'sendgrid',
      });
      continue;
    }
    if (event === 'blocked') {
      events.push({
        recipientEmail: email,
        messageId,
        status: 'bounced',
        error: asString(obj.reason) ?? asString(obj.response) ?? 'SendGrid blocked',
        provider: 'sendgrid',
      });
      continue;
    }
    if (event === 'dropped') {
      const reason = (asString(obj.reason) ?? '').toLowerCase();
      const recipientPermanent = [
        'bounced address',
        'spam reported address',
        'unsubscribed address',
        'invalid email',
        'invalid address',
      ];
      if (recipientPermanent.some((r) => reason.includes(r))) {
        events.push({
          recipientEmail: email,
          messageId,
          status: 'dropped',
          error: asString(obj.reason) ?? 'SendGrid dropped',
          provider: 'sendgrid',
        });
      }
      continue;
    }
  }
  return events;
}

function parseMailgunPayload(payload: Record<string, unknown>): ParsedEmailDeliveryEvent[] {
  const eventData =
    asObject(payload['event-data']) ?? asObject(payload.event_data);
  if (eventData) {
    const event = asString(eventData.event);
    if (!event) return [];
    const recipient = normaliseEmail(eventData.recipient);
    if (!recipient) return [];
    const message = asObject(eventData.message);
    const headers = message ? asObject(message.headers) : null;
    const messageId = headers ? normaliseMessageId(headers['message-id']) : null;
    const reason =
      asString(eventData.reason) ??
      asString(eventData['delivery-status']) ??
      null;

    if (event === 'delivered') {
      return [
        { recipientEmail: recipient, messageId, status: 'delivered', error: null, provider: 'mailgun' },
      ];
    }
    if (event === 'complained') {
      return [
        {
          recipientEmail: recipient,
          messageId,
          status: 'spam',
          error: reason ?? 'Mailgun spam complaint',
          provider: 'mailgun',
        },
      ];
    }
    if (event === 'failed') {
      const severity = asString(eventData.severity);
      if (severity === 'permanent') {
        return [
          {
            recipientEmail: recipient,
            messageId,
            status: 'bounced',
            error: reason ?? 'Mailgun permanent failure',
            provider: 'mailgun',
          },
        ];
      }
      if (severity === 'temporary') {
        return [
          {
            recipientEmail: recipient,
            messageId,
            status: 'deferred',
            error: reason ?? 'Mailgun temporary failure',
            provider: 'mailgun',
          },
        ];
      }
    }
    return [];
  }

  // Older flat form-encoded shape.
  const recipient = normaliseEmail(payload.recipient);
  if (!recipient) return [];
  const messageId =
    normaliseMessageId(payload['Message-Id']) ??
    normaliseMessageId(payload['message-id']);
  const event = asString(payload.event);

  if (event === 'delivered') {
    return [
      { recipientEmail: recipient, messageId, status: 'delivered', error: null, provider: 'mailgun' },
    ];
  }
  if (event === 'complained') {
    return [
      {
        recipientEmail: recipient,
        messageId,
        status: 'spam',
        error: asString(payload.reason) ?? 'Mailgun spam complaint',
        provider: 'mailgun',
      },
    ];
  }
  if (event === 'bounced' || event === 'failed') {
    if (
      payload.severity != null &&
      asString(payload.severity) !== 'permanent'
    ) {
      return [
        {
          recipientEmail: recipient,
          messageId,
          status: 'deferred',
          error:
            asString(payload.reason) ??
            asString(payload.notification) ??
            asString(payload.error) ??
            'Mailgun temporary failure',
          provider: 'mailgun',
        },
      ];
    }
    return [
      {
        recipientEmail: recipient,
        messageId,
        status: 'bounced',
        error:
          asString(payload.reason) ??
          asString(payload.notification) ??
          asString(payload.error) ??
          'Mailgun bounce',
        provider: 'mailgun',
      },
    ];
  }
  return [];
}

export function parseEmailDeliveryWebhookPayload(
  payload: unknown,
): ParsedEmailDeliveryEvent[] {
  if (Array.isArray(payload)) {
    return parseSendGridPayload(payload);
  }
  const obj = asObject(payload);
  if (!obj) return [];

  if (
    obj.Type === 'Notification' ||
    asString(obj.notificationType) !== null ||
    asString(obj.eventType) !== null
  ) {
    const ses = parseSesPayload(obj);
    if (ses.length > 0) return ses;
  }

  if (asString(obj.RecordType) !== null) {
    return parsePostmarkPayload(obj);
  }

  if (
    asObject(obj['event-data']) ||
    asObject(obj.event_data) ||
    asString(obj.event) !== null
  ) {
    return parseMailgunPayload(obj);
  }

  return [];
}
