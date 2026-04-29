import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { createLogger } from '../../../platform/core/logger';
import {
  recordLead,
  attachBookingToLead,
  attachBookingToLeadById,
  notifyBookingConfirmed,
  findLatestLeadByEmail,
  findLeadById,
  type BookingDetails,
} from '../services/marketing-leads';

const logger = createLogger('CONTACT');

const router = Router();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/contact', async (req: Request, res: Response) => {
  const { name, email, company, message } = req.body ?? {};

  if (!name || !email || !message) {
    res.status(400).json({ error: 'Name, email, and message are required' });
    return;
  }
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  logger.info('Contact form submission received', {
    name,
    email,
    company: company || '(not provided)',
    messageLength: String(message).length,
  });

  await recordLead({
    source: 'contact',
    name,
    email,
    company: company || null,
    payload: { message },
  });

  res.json({ success: true, message: 'Your message has been received. We will get back to you shortly.' });
});

router.post('/book-demo', async (req: Request, res: Response) => {
  const { name, email, company, phone, teamSize, useCase, preferredTime } = req.body ?? {};

  if (!name || !email || !company) {
    res.status(400).json({ error: 'Name, email, and company are required' });
    return;
  }
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  const result = await recordLead({
    source: 'book_demo',
    name,
    email,
    company,
    phone: phone || null,
    payload: { teamSize, useCase, preferredTime },
  });

  res.json({
    success: true,
    leadId: result.id,
    message: 'Demo request received. Pick a time on the calendar to confirm your slot.',
  });
});

router.post('/roi-lead', async (req: Request, res: Response) => {
  const { email, name, company, results, inputs, vertical } = req.body ?? {};

  if (!email || !emailRegex.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }

  await recordLead({
    source: 'roi_calculator',
    email,
    name: name || null,
    company: company || null,
    payload: { results, inputs, vertical },
  });

  res.json({
    success: true,
    message: 'Your ROI report is on its way. Check your inbox shortly.',
  });
});

// ---------- Calendar webhook (Cal.com + Calendly) ----------

type SignatureResult =
  | { ok: true }
  | { ok: false; status: 500 | 401; error: string };

function verifyCalcomSignature(rawBody: Buffer, signatureHeader: string | undefined): SignatureResult {
  const secret = (process.env.CALCOM_WEBHOOK_SECRET ?? '').trim();
  if (!secret) {
    // Fail-closed: never accept unsigned webhooks. Allow only when explicit
    // dev opt-in is set so local testing can still exercise the flow.
    const allowUnsigned =
      (process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED ?? '').trim() === '1' &&
      (process.env.NODE_ENV ?? 'development') !== 'production' &&
      (process.env.APP_ENV ?? 'development') !== 'production';
    if (allowUnsigned) {
      logger.warn('CALCOM_WEBHOOK_SECRET not configured — accepting webhook (CALCOM_WEBHOOK_ALLOW_UNSIGNED=1, non-production only)');
      return { ok: true };
    }
    logger.error('CALCOM_WEBHOOK_SECRET not configured — rejecting webhook (set the secret to enable signature verification)');
    return { ok: false, status: 500, error: 'Webhook secret not configured' };
  }
  if (!signatureHeader) {
    return { ok: false, status: 401, error: 'Missing signature' };
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    // Strip optional "sha256=" prefix and any whitespace.
    const provided = signatureHeader.trim().replace(/^sha256=/i, '');
    if (!/^[a-f0-9]+$/i.test(provided) || provided.length !== expected.length) {
      return { ok: false, status: 401, error: 'Invalid signature format' };
    }
    const equal = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided.toLowerCase(), 'hex'));
    return equal ? { ok: true } : { ok: false, status: 401, error: 'Invalid signature' };
  } catch {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
}

/**
 * Verify a Calendly v1 webhook signature header. The header looks like
 * `t=<unix_seconds>,v1=<hex_hmac>` and the HMAC is computed as
 * `HMAC_SHA256(secret, "<timestamp>.<raw_body>")`. We also reject signatures
 * older than 5 minutes to mitigate replay attacks (the same tolerance Calendly
 * recommends in their docs).
 */
function verifyCalendlySignature(rawBody: Buffer, signatureHeader: string | undefined): SignatureResult {
  const secret = (process.env.CALENDLY_WEBHOOK_SECRET ?? '').trim();
  if (!secret) {
    const allowUnsigned =
      (process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED ?? '').trim() === '1' &&
      (process.env.NODE_ENV ?? 'development') !== 'production' &&
      (process.env.APP_ENV ?? 'development') !== 'production';
    if (allowUnsigned) {
      logger.warn('CALENDLY_WEBHOOK_SECRET not configured — accepting webhook (CALENDLY_WEBHOOK_ALLOW_UNSIGNED=1, non-production only)');
      return { ok: true };
    }
    logger.error('CALENDLY_WEBHOOK_SECRET not configured — rejecting Calendly webhook (set the secret to enable signature verification)');
    return { ok: false, status: 500, error: 'Webhook secret not configured' };
  }
  if (!signatureHeader) {
    return { ok: false, status: 401, error: 'Missing signature' };
  }

  // Parse the comma-separated "t=...,v1=..." header. We tolerate extra parts
  // (e.g. future v2 versions) and pick the one we know how to verify.
  let timestamp: string | null = null;
  let v1Sig: string | null = null;
  for (const segment of signatureHeader.split(',')) {
    const part = segment.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && !timestamp) timestamp = value;
    else if (key === 'v1' && !v1Sig) v1Sig = value;
  }

  if (!timestamp || !v1Sig) {
    return { ok: false, status: 401, error: 'Invalid signature format' };
  }
  if (!/^[a-f0-9]+$/i.test(v1Sig)) {
    return { ok: false, status: 401, error: 'Invalid signature format' };
  }
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) {
    return { ok: false, status: 401, error: 'Invalid signature format' };
  }

  // 5-minute replay window. Configurable via CALENDLY_WEBHOOK_TOLERANCE_SECONDS
  // for environments that need a wider tolerance (e.g. clock-skewed CI).
  const tolerance = Math.max(
    1,
    Number(process.env.CALENDLY_WEBHOOK_TOLERANCE_SECONDS ?? '300') || 300,
  );
  const ageSeconds = Math.abs(Date.now() / 1000 - tsSeconds);
  if (ageSeconds > tolerance) {
    return { ok: false, status: 401, error: 'Signature timestamp out of tolerance' };
  }

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  try {
    if (expected.length !== v1Sig.length) {
      return { ok: false, status: 401, error: 'Invalid signature' };
    }
    const equal = crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(v1Sig.toLowerCase(), 'hex'),
    );
    return equal ? { ok: true } : { ok: false, status: 401, error: 'Invalid signature' };
  } catch {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
}

interface CalcomAttendee {
  email?: string;
  name?: string;
  timeZone?: string;
}

interface CalcomBookingPayload {
  uid?: string;
  bookingId?: number | string;
  id?: number | string;
  startTime?: string;
  endTime?: string;
  title?: string;
  attendees?: CalcomAttendee[];
  organizer?: CalcomAttendee;
  metadata?: Record<string, unknown>;
  videoCallData?: { url?: string };
  meetingUrl?: string;
  rescheduleUid?: string;
  rescheduleUrl?: string;
  cancelUrl?: string;
}

interface CalcomWebhookEnvelope {
  triggerEvent?: string;
  payload?: CalcomBookingPayload;
}

interface CalendlyScheduledEvent {
  uri?: string;
  name?: string;
  start_time?: string;
  end_time?: string;
  location?: { type?: string; join_url?: string; location?: string };
}

interface CalendlyInviteePayload {
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  uri?: string;
  cancel_url?: string;
  reschedule_url?: string;
  rescheduled?: boolean;
  old_invitee?: string | null;
  timezone?: string;
  status?: string;
  cancellation?: { canceled_by?: string; reason?: string } | null;
  scheduled_event?: CalendlyScheduledEvent;
  tracking?: {
    utm_content?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    salesforce_uuid?: string;
  };
  questions_and_answers?: Array<{ question?: string; answer?: string }>;
}

interface CalendlyWebhookEnvelope {
  event?: string;
  payload?: CalendlyInviteePayload;
}

function parseLeadIdFromValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    // Accept both "42" and "lead-42" so we can pull leadId out of utm_content.
    const match = value.match(/(\d+)/);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function calendlyEventToBookingType(event: string): BookingDetails['eventType'] {
  // `invitee.canceled` always means the invitee is no longer attending.
  // `invitee.created` covers both fresh bookings and the new half of a
  // reschedule (Calendly fires `invitee.canceled` for the old slot followed
  // by `invitee.created` with `rescheduled: true` for the new slot).
  if (event === 'invitee.canceled' || event === 'invitee.cancelled') return 'cancelled';
  return 'created';
}

async function handleCalcomWebhook(raw: Buffer, signature: string | undefined, res: Response): Promise<void> {
  const sigResult = verifyCalcomSignature(raw, signature);
  if (!sigResult.ok) {
    logger.warn('Cal.com webhook rejected', { reason: sigResult.error, status: sigResult.status });
    res.status(sigResult.status).json({ error: sigResult.error });
    return;
  }

  let event: CalcomWebhookEnvelope;
  try {
    event = JSON.parse(raw.toString('utf8')) as CalcomWebhookEnvelope;
  } catch (err) {
    logger.warn('Cal.com webhook body could not be parsed as JSON', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const trigger = (event.triggerEvent || '').toUpperCase();
  const payload = event.payload || {};
  const attendee = payload.attendees?.[0];
  const attendeeEmail = attendee?.email?.trim();

  // Prefer the leadId we round-tripped via Cal.com metadata (set by BookDemo.tsx)
  // so a booking always attaches to the exact lead that triggered the form,
  // even if the attendee edited the email or two leads share the same address.
  const metadataLeadId = parseLeadIdFromValue(payload.metadata?.leadId);

  if (!metadataLeadId && (!attendeeEmail || !emailRegex.test(attendeeEmail))) {
    logger.warn('Cal.com webhook missing both metadata.leadId and attendee email — acknowledging without action', { trigger });
    res.json({ ok: true, ignored: true });
    return;
  }

  const eventType: BookingDetails['eventType'] =
    trigger === 'BOOKING_CANCELLED' || trigger === 'BOOKING_REJECTED'
      ? 'cancelled'
      : trigger === 'BOOKING_RESCHEDULED'
        ? 'rescheduled'
        : 'created';

  const booking: BookingDetails = {
    provider: 'cal.com',
    eventType,
    bookingId: payload.bookingId ?? payload.id ?? null,
    bookingUid: payload.uid ?? null,
    startTime: payload.startTime ?? null,
    endTime: payload.endTime ?? null,
    timezone: attendee?.timeZone ?? payload.organizer?.timeZone ?? null,
    attendeeEmail: attendeeEmail ?? null,
    attendeeName: attendee?.name ?? null,
    meetingUrl: payload.videoCallData?.url ?? payload.meetingUrl ?? null,
    rescheduleUrl: payload.rescheduleUrl ?? null,
    cancelUrl: payload.cancelUrl ?? null,
    title: payload.title ?? null,
    raw: payload as unknown as Record<string, unknown>,
  };

  await dispatchBookingWebhook({
    res,
    provider: 'cal.com',
    trigger,
    metadataLeadId,
    attendeeEmail: attendeeEmail ?? null,
    booking,
  });
}

async function handleCalendlyWebhook(raw: Buffer, signature: string | undefined, res: Response): Promise<void> {
  const sigResult = verifyCalendlySignature(raw, signature);
  if (!sigResult.ok) {
    logger.warn('Calendly webhook rejected', { reason: sigResult.error, status: sigResult.status });
    res.status(sigResult.status).json({ error: sigResult.error });
    return;
  }

  let event: CalendlyWebhookEnvelope;
  try {
    event = JSON.parse(raw.toString('utf8')) as CalendlyWebhookEnvelope;
  } catch (err) {
    logger.warn('Calendly webhook body could not be parsed as JSON', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const eventName = (event.event || '').trim().toLowerCase();
  const payload = event.payload || {};

  // Only `invitee.created` (incl. reschedule "new slot") and `invitee.canceled`
  // are mirrored into the marketing-leads pipeline. Other Calendly events
  // (e.g. `routing_form_submission.created`) are acknowledged but ignored so
  // Calendly doesn't keep retrying.
  if (eventName !== 'invitee.created' && eventName !== 'invitee.canceled' && eventName !== 'invitee.cancelled') {
    logger.info('Calendly webhook event type not handled — acknowledging', { event: eventName });
    res.json({ ok: true, ignored: true, reason: 'unsupported_event' });
    return;
  }

  const eventType = calendlyEventToBookingType(eventName);
  const attendeeEmail = payload.email?.trim() || null;

  // Calendly's `name` field is the full display name. Fall back to first/last
  // when only those are populated.
  const attendeeName =
    (payload.name && payload.name.trim()) ||
    [payload.first_name, payload.last_name].filter((s): s is string => !!s && s.trim().length > 0).join(' ').trim() ||
    null;

  // We round-trip the leadId via the `utm_content=lead-<id>` query param in
  // `client-app/src/pages/public/BookDemo.tsx`. Calendly surfaces it back to
  // us under `payload.tracking.utm_content`.
  const metadataLeadId = parseLeadIdFromValue(payload.tracking?.utm_content);

  if (!metadataLeadId && (!attendeeEmail || !emailRegex.test(attendeeEmail))) {
    logger.warn('Calendly webhook missing both leadId tracking and invitee email — acknowledging without action', {
      event: eventName,
    });
    res.json({ ok: true, ignored: true });
    return;
  }

  const scheduled = payload.scheduled_event ?? {};
  // Calendly normalises virtual conference links to `location.join_url`
  // regardless of provider (Zoom / Google Meet / Teams / Webex). Physical or
  // phone-call locations don't expose a URL, so this is null in that case.
  const meetingUrl = scheduled.location?.join_url ?? null;

  const booking: BookingDetails = {
    provider: 'calendly',
    eventType,
    // Calendly invitees and scheduled_events both have stable URI ids; we use
    // the invitee URI as the dedupe key because each lifecycle event maps to
    // a unique invitee.
    bookingId: scheduled.uri ?? null,
    bookingUid: payload.uri ?? null,
    startTime: scheduled.start_time ?? null,
    endTime: scheduled.end_time ?? null,
    timezone: payload.timezone ?? null,
    attendeeEmail,
    attendeeName,
    meetingUrl,
    rescheduleUrl: payload.reschedule_url ?? null,
    cancelUrl: payload.cancel_url ?? null,
    title: scheduled.name ?? null,
    raw: payload as unknown as Record<string, unknown>,
  };

  await dispatchBookingWebhook({
    res,
    provider: 'calendly',
    trigger: eventName,
    metadataLeadId,
    attendeeEmail,
    booking,
  });
}

interface DispatchBookingArgs {
  res: Response;
  provider: 'cal.com' | 'calendly';
  trigger: string;
  metadataLeadId: number | null;
  attendeeEmail: string | null;
  booking: BookingDetails;
}

/**
 * Shared post-verification booking pipeline used by both the Cal.com and
 * Calendly handlers. Resolves the lead row (preferring metadata.leadId, then
 * falling back to email lookup), persists the booking onto the lead's
 * payload, and fires the sales-inbox notification — all idempotently.
 */
async function dispatchBookingWebhook(args: DispatchBookingArgs): Promise<void> {
  const { res, provider, trigger, metadataLeadId, attendeeEmail, booking } = args;

  let leadId: number | null = null;
  let duplicate = false;
  let lead: { id: number; name: string | null; company: string | null; email: string } | null = null;

  if (metadataLeadId) {
    const byId = await findLeadById(metadataLeadId);
    if (byId) {
      const r = await attachBookingToLeadById(byId.id, booking);
      leadId = r.leadId;
      duplicate = r.duplicate;
      lead = { id: byId.id, name: byId.name, company: byId.company, email: byId.email };
    } else {
      logger.warn(`${provider} webhook metadata leadId did not match any existing lead — falling back to email lookup`, {
        metadataLeadId,
        attendeeEmail,
      });
    }
  }

  if (!leadId) {
    if (!attendeeEmail) {
      logger.warn(`${provider} webhook unable to resolve lead (no metadata.leadId and no attendee email)`, { trigger });
      res.json({ ok: true, ignored: true });
      return;
    }
    const r = await attachBookingToLead(attendeeEmail, booking);
    leadId = r.leadId;
    duplicate = r.duplicate;
    const matched = await findLatestLeadByEmail(attendeeEmail, 'book_demo');
    if (matched) {
      lead = { id: matched.id, name: matched.name, company: matched.company, email: attendeeEmail };
    }
  }

  // Idempotency: skip notifications when this exact booking event was already
  // processed (providers retry the same event on transient errors).
  if (!duplicate) {
    const notifyEmail = lead?.email ?? attendeeEmail ?? booking.attendeeEmail ?? '';
    if (notifyEmail) {
      await notifyBookingConfirmed(notifyEmail, booking, {
        leadId,
        name: lead?.name ?? booking.attendeeName ?? null,
        company: lead?.company ?? null,
      });
    }
  }

  logger.info(`${provider} webhook processed`, {
    trigger,
    eventType: booking.eventType,
    leadId,
    metadataLeadId,
    attendeeEmail,
    bookingId: booking.bookingId,
    duplicate,
  });

  res.json({ ok: true, leadId, duplicate });
}

router.post('/book-demo/calendar-webhook', async (req: Request, res: Response) => {
  // The router mount in app.ts attaches express.raw before json for this path,
  // so req.body should be a Buffer here.
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

  const calendlySig =
    req.header('calendly-webhook-signature') ||
    req.header('Calendly-Webhook-Signature') ||
    undefined;

  // Detect Calendly by the presence of its dedicated signature header. This
  // keeps the public webhook URL stable across providers while letting us
  // verify each provider with the right algorithm.
  if (calendlySig) {
    await handleCalendlyWebhook(raw, calendlySig, res);
    return;
  }

  const calcomSig =
    req.header('x-cal-signature-256') ||
    req.header('X-Cal-Signature-256') ||
    req.header('x-cal-signature') ||
    undefined;

  await handleCalcomWebhook(raw, calcomSig, res);
});

export default router;
