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

// ---------- Cal.com webhook ----------

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

router.post('/book-demo/calendar-webhook', async (req: Request, res: Response) => {
  // The router mount in app.ts attaches express.raw before json for this path,
  // so req.body should be a Buffer here.
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

  const signature =
    (req.header('x-cal-signature-256') ||
      req.header('X-Cal-Signature-256') ||
      req.header('x-cal-signature') ||
      undefined);

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
  const metadataLeadIdRaw = payload.metadata?.leadId;
  const metadataLeadId = (() => {
    if (typeof metadataLeadIdRaw === 'number' && Number.isFinite(metadataLeadIdRaw)) {
      return Math.trunc(metadataLeadIdRaw);
    }
    if (typeof metadataLeadIdRaw === 'string') {
      const parsed = parseInt(metadataLeadIdRaw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  })();

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

  // Resolve the lead. Prefer metadata.leadId (round-tripped from BookDemo.tsx)
  // and only fall back to email when the metadata id can't be matched.
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
      logger.warn('Cal.com metadata.leadId did not match any existing lead — falling back to email lookup', {
        metadataLeadId,
        attendeeEmail,
      });
    }
  }

  if (!leadId) {
    if (!attendeeEmail) {
      logger.warn('Cal.com webhook unable to resolve lead (no metadata.leadId and no attendee email)', { trigger });
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
  // processed (Cal.com retries the same event on transient errors).
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

  logger.info('Cal.com webhook processed', {
    trigger,
    eventType,
    leadId,
    metadataLeadId,
    attendeeEmail,
    bookingId: booking.bookingId,
    duplicate,
  });

  res.json({ ok: true, leadId, duplicate });
});

export default router;
