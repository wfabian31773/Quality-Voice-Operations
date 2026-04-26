/**
 * Provider-agnostic parser for asynchronous email bounce webhooks
 * (SES, Postmark, SendGrid, Mailgun). Returns one `ParsedBounceEvent`
 * per recipient that the provider classifies as a permanent (hard)
 * bounce; soft bounces, delays, and complaints are intentionally dropped.
 *
 * Provider detection is shape-based so a single webhook URL works for
 * every provider. Unknown payloads return an empty list — the route
 * handler responds 202 so the provider doesn't retry indefinitely.
 */

export interface ParsedBounceEvent {
  /** Lowercased recipient address whose send hard-bounced. */
  recipientEmail: string;
  /** Provider-reported original-send message id, or null if not provided. */
  messageId: string | null;
  /** Provider-supplied human-readable error (SMTP reason / diagnostic). */
  error: string;
  /** Detected provider name, used for logging only. */
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

/**
 * AWS SES via SNS. Handles both the SNS `Type:"Notification"` envelope
 * (with a stringified `Message`) and a direct SES Event-Destination POST.
 * Only `bounceType:"Permanent"` produces events.
 */
function parseSesPayload(payload: Record<string, unknown>): ParsedBounceEvent[] {
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
  if (notificationType !== 'Bounce') return [];

  const bounce = asObject(inner.bounce);
  if (!bounce) return [];
  // SES uses "Permanent" for hard bounces. Transient/Undetermined are soft.
  if (asString(bounce.bounceType) !== 'Permanent') return [];

  const mail = asObject(inner.mail) ?? {};
  const messageId = asString(mail.messageId);
  const recipients = Array.isArray(bounce.bouncedRecipients)
    ? (bounce.bouncedRecipients as unknown[])
    : [];

  const events: ParsedBounceEvent[] = [];
  for (const r of recipients) {
    const obj = asObject(r);
    if (!obj) continue;
    const email = normaliseEmail(obj.emailAddress);
    if (!email) continue;
    // Prefer the per-recipient diagnostic code; fall back to the bounce
    // sub-type so the stored error is always populated with something useful.
    const diag =
      asString(obj.diagnosticCode) ??
      asString(bounce.bounceSubType) ??
      'SES permanent bounce';
    events.push({ recipientEmail: email, messageId, error: diag, provider: 'ses' });
  }
  return events;
}

/**
 * Postmark bounce webhook. The set below covers every Postmark Type that
 * renders the address undeliverable (hard / blocked / unknown 5xx).
 * See https://postmarkapp.com/developer/webhooks/bounce-webhook.
 */
const POSTMARK_HARD_BOUNCE_TYPES = new Set([
  'HardBounce',
  'BadEmailAddress',
  'ManuallyDeactivated',
  'Unknown',
  'Blocked',
]);

function parsePostmarkPayload(payload: Record<string, unknown>): ParsedBounceEvent[] {
  if (asString(payload.RecordType) !== 'Bounce') return [];
  const type = asString(payload.Type);
  if (!type || !POSTMARK_HARD_BOUNCE_TYPES.has(type)) return [];
  const email = normaliseEmail(payload.Email ?? payload.EmailAddress);
  if (!email) return [];
  const messageId = asString(payload.MessageID);
  const error =
    asString(payload.Description) ??
    asString(payload.Details) ??
    `Postmark ${type}`;
  return [{ recipientEmail: email, messageId, error, provider: 'postmark' }];
}

/**
 * SendGrid Event Webhook (top-level array). Permanent failures are
 * `event:"bounce"` with `type:"bounce"`, `event:"blocked"` (5xx),
 * and `event:"dropped"` with an address-shaped reason.
 */
function parseSendGridPayload(payloadList: unknown[]): ParsedBounceEvent[] {
  const events: ParsedBounceEvent[] = [];
  for (const raw of payloadList) {
    const obj = asObject(raw);
    if (!obj) continue;
    const event = asString(obj.event);
    if (!event) continue;
    let permanent = false;
    if (event === 'bounce' && asString(obj.type) === 'bounce') permanent = true;
    if (event === 'blocked') permanent = true;
    if (event === 'dropped') {
      // SendGrid drops with sender-side reasons too (e.g. "Invalid SMTPAPI
      // header", "Recipient List over Package Quota") that must NOT be
      // treated as recipient failures — flagging them would create false
      // suppressions and page ops. The allowlist below targets only the
      // documented recipient-attributable drop reasons.
      // See https://docs.sendgrid.com/for-developers/tracking-events/event#drop
      const reason = (asString(obj.reason) ?? '').toLowerCase();
      const recipientPermanent = [
        'bounced address',
        'spam reported address',
        'unsubscribed address',
        'invalid email',
        'invalid address',
      ];
      if (recipientPermanent.some(r => reason.includes(r))) permanent = true;
    }
    if (!permanent) continue;
    const email = normaliseEmail(obj.email);
    if (!email) continue;
    const messageId = asString(obj.sg_message_id) ?? asString(obj['smtp-id']);
    const error =
      asString(obj.reason) ??
      asString(obj.response) ??
      `SendGrid ${event}`;
    events.push({ recipientEmail: email, messageId, error, provider: 'sendgrid' });
  }
  return events;
}

/**
 * Mailgun. Supports both the newer JSON `event-data` envelope and the
 * older flat form-encoded webhook. Only `severity:"permanent"` is a hard
 * bounce; `temporary` is a soft retry that our own loop already handles.
 */
function parseMailgunPayload(payload: Record<string, unknown>): ParsedBounceEvent[] {
  // Newer "event_data" envelope. The provider hyphenates as `event-data`.
  const eventData =
    asObject(payload['event-data']) ?? asObject(payload.event_data);
  if (eventData) {
    if (asString(eventData.event) !== 'failed') return [];
    if (asString(eventData.severity) !== 'permanent') return [];
    const recipient = normaliseEmail(eventData.recipient);
    if (!recipient) return [];
    const message = asObject(eventData.message);
    const headers = message ? asObject(message.headers) : null;
    const messageId = headers ? asString(headers['message-id']) : null;
    const reason =
      asString(eventData.reason) ??
      asString(eventData['delivery-status']) ??
      'Mailgun permanent failure';
    return [
      { recipientEmail: recipient, messageId, error: reason, provider: 'mailgun' },
    ];
  }
  // Older flat shape (form-encoded → object after express.urlencoded parse).
  if (asString(payload.event) === 'bounced' || asString(payload.event) === 'failed') {
    if (
      payload.severity != null &&
      asString(payload.severity) !== 'permanent'
    ) {
      return [];
    }
    const recipient = normaliseEmail(payload.recipient);
    if (!recipient) return [];
    const messageId = asString(payload['Message-Id']) ?? asString(payload['message-id']);
    const reason =
      asString(payload.reason) ??
      asString(payload.notification) ??
      asString(payload.error) ??
      'Mailgun bounce';
    return [
      { recipientEmail: recipient, messageId, error: reason, provider: 'mailgun' },
    ];
  }
  return [];
}

/**
 * Sniffs the payload shape and dispatches to the right provider parser.
 * Returns an empty array for unknown shapes so the route handler can
 * 202 the request and the provider stops retrying.
 */
export function parseBounceWebhookPayload(payload: unknown): ParsedBounceEvent[] {
  if (Array.isArray(payload)) {
    return parseSendGridPayload(payload);
  }
  const obj = asObject(payload);
  if (!obj) return [];

  if (
    obj.Type === 'Notification' ||
    asString(obj.notificationType) === 'Bounce' ||
    asString(obj.eventType) === 'Bounce'
  ) {
    return parseSesPayload(obj);
  }

  if (asString(obj.RecordType) === 'Bounce') {
    return parsePostmarkPayload(obj);
  }

  if (
    asObject(obj['event-data']) ||
    asObject(obj.event_data) ||
    asString(obj.event) === 'failed' ||
    asString(obj.event) === 'bounced'
  ) {
    return parseMailgunPayload(obj);
  }

  return [];
}
