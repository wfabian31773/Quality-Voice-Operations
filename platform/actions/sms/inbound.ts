import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isSmsOptOut } from '../../campaigns/DncService';
import { createLogger } from '../../core/logger';
import { redactPHI } from '../../core/phi/redact';
import { withTenantClient } from '../../db';
import {
  evaluateAutoReplies,
  evaluateAssignmentRules,
  logActivity,
  saveMessage,
  updateConversation,
  type SmsConversation,
} from '../../sms/SmsConversationService';
import { isLikelySmsOptOut, isSmsHelp, isSmsOptIn, liftSmsOptOutDnc } from './consent';
import { normalizeE164 } from './send';

const logger = createLogger('SMS_INBOUND');

/** Twilio inbound `Body` max (concatenated SMS). Outbound still uses `SMS_MAX_BODY_CHARS` (640). */
export const SMS_MAX_INBOUND_BODY_CHARS = 1600;

const MESSAGE_SID_RE = /^(SM|MM)[A-Za-z0-9]{1,62}$/;
const MAX_MEDIA = 10;
const MAX_MEDIA_URL_CHARS = 2048;
const MAX_MEDIA_TYPE_CHARS = 128;
const INBOUND_LOCK_PREFIX = 'sms-inbound:';

export const EMPTY_INBOUND_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function inboundSmsTwiml(inner = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function escapeTwimlText(value: string): string {
  return value.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}

export interface InboundMedia {
  url: string;
  contentType: string | null;
}

export interface ParsedInboundSms {
  from: string;
  to: string;
  messageSid: string;
  body: string;
  numMedia: number;
  media: InboundMedia[];
}

export interface InboundSmsResult {
  twiml: string;
  httpStatus: 200 | 500;
  duplicate?: boolean;
}

export interface InboundConversation {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  remoteNumber: string;
  assigneeUserId: string | null;
  assigneeTeam: string | null;
  contactLocation: string | null;
}

export type InboundKeyword = 'opt_out' | 'opt_in' | 'help' | null;

export interface PersistInboundInput {
  tenantId: string;
  phoneNumberId: string;
  parsed: ParsedInboundSms;
  keyword: InboundKeyword;
  likelyOptOut: boolean;
}

export type PersistInboundResult =
  | { duplicate: true }
  | { duplicate: false; conversation: InboundConversation };

type SqlClient = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

export interface SmsInboundStore {
  persistInbound(input: PersistInboundInput): Promise<PersistInboundResult>;
}

export interface SmsInboundLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface SmsInboundDeps {
  lookupByTo: (to: string) => Promise<{ tenantId: string; phoneNumberId: string } | null>;
  store: SmsInboundStore;
  isOptOut: (body: string) => boolean;
  isOptIn: (body: string) => boolean;
  isHelp: (body: string) => boolean;
  isLikelyOptOut: (body: string) => boolean;
  tryRecordCsat: (
    tenantId: string,
    from: string,
    body: string,
  ) => Promise<{ handled: true; csat: { id: string } } | { handled: false }>;
  markCsatOptedOut: (tenantId: string, from: string) => Promise<unknown>;
  evaluateAutoReplies: (tenantId: string, body: string, phoneNumberId: string) => Promise<string | null>;
  evaluateAssignmentRules: (
    tenantId: string,
    conversation: InboundConversation,
    body: string,
  ) => Promise<{ userId?: string; team?: string } | null>;
  updateConversation: (
    tenantId: string,
    conversationId: string,
    updates: { assigneeUserId?: string; assigneeTeam?: string },
  ) => Promise<unknown>;
  logActivity: (
    tenantId: string,
    conversationId: string,
    action: string,
    actorUserId: string | null,
    actorName: string | null,
    details?: Record<string, unknown>,
  ) => Promise<void>;
  saveAutoReply: (args: {
    tenantId: string;
    conversationId: string;
    fromNumber: string;
    toNumber: string;
    body: string;
  }) => Promise<void>;
  logger: SmsInboundLogger;
}

const inboundFieldsSchema = z
  .object({
    From: z.string().min(1),
    To: z.string().min(1),
    MessageSid: z.string().regex(MESSAGE_SID_RE),
    Body: z.string().max(SMS_MAX_INBOUND_BODY_CHARS).optional(),
    NumMedia: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

function parseNumMedia(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw <= MAX_MEDIA ? raw : null;
  }
  if (typeof raw === 'string' && /^\d{1,2}$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return n >= 0 && n <= MAX_MEDIA ? n : null;
  }
  return null;
}

function parseHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MEDIA_URL_CHARS) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return raw;
  } catch {
    return null;
  }
}

function parseMedia(
  raw: Record<string, unknown>,
  numMedia: number,
): { ok: true; media: InboundMedia[] } | { ok: false } {
  const media: InboundMedia[] = [];
  for (let i = 0; i < numMedia; i++) {
    const urlRaw = raw[`MediaUrl${i}`];
    const typeRaw = raw[`MediaContentType${i}`];
    if (urlRaw === undefined || urlRaw === '') continue;
    const url = parseHttpUrl(urlRaw);
    if (!url) return { ok: false };
    if (typeRaw !== undefined && typeRaw !== '' && typeRaw !== null) {
      if (typeof typeRaw !== 'string' || typeRaw.length > MAX_MEDIA_TYPE_CHARS) return { ok: false };
    }
    const contentType = typeof typeRaw === 'string' && typeRaw.length > 0 ? typeRaw : null;
    media.push({ url, contentType });
  }
  return { ok: true, media };
}

/**
 * Validates a Twilio inbound webhook body. Invalid input returns null; the
 * caller logs a warn (no PHI) and replies with empty TwiML.
 */
export function parseInboundSmsPayload(payload: unknown): ParsedInboundSms | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const parsed = inboundFieldsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const from = normalizeE164(parsed.data.From);
  const to = normalizeE164(parsed.data.To);
  if (!from || !to) return null;
  const numMedia = parseNumMedia(parsed.data.NumMedia);
  if (numMedia === null) return null;
  const media = parseMedia(raw, numMedia);
  if (!media.ok) return null;
  return {
    from,
    to,
    messageSid: parsed.data.MessageSid,
    body: parsed.data.Body ?? '',
    numMedia,
    media: media.media,
  };
}

function inboundMetadata(parsed: ParsedInboundSms): Record<string, unknown> {
  return {
    numMedia: parsed.numMedia,
    ...(parsed.media.length > 0 ? { media: parsed.media } : {}),
  };
}

function conversationFromRow(row: Record<string, unknown>, tenantId: string): InboundConversation {
  return {
    id: row.id as string,
    tenantId,
    phoneNumberId: row.phone_number_id as string,
    remoteNumber: row.remote_number as string,
    assigneeUserId: (row.assignee_user_id as string | null) ?? null,
    assigneeTeam: (row.assignee_team as string | null) ?? null,
    contactLocation: (row.contact_location as string | null) ?? null,
  };
}

async function getOrCreateConversation(
  client: SqlClient,
  tenantId: string,
  phoneNumberId: string,
  remoteNumber: string,
  newId: () => string,
): Promise<InboundConversation> {
  const { rows: existing } = await client.query(
    `SELECT * FROM sms_conversations WHERE tenant_id = $1 AND phone_number_id = $2 AND remote_number = $3 LIMIT 1`,
    [tenantId, phoneNumberId, remoteNumber],
  );
  if (existing[0]) return conversationFromRow(existing[0], tenantId);
  const { rows } = await client.query(
    `INSERT INTO sms_conversations (id, tenant_id, phone_number_id, remote_number, status)
     VALUES ($1, $2, $3, $4, 'open')
     ON CONFLICT (tenant_id, phone_number_id, remote_number) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [newId(), tenantId, phoneNumberId, remoteNumber],
  );
  if (!rows[0]) throw new Error('Failed to create SMS conversation');
  return conversationFromRow(rows[0], tenantId);
}

async function persistInboundOnClient(
  client: SqlClient,
  input: PersistInboundInput,
  newId: () => string,
): Promise<PersistInboundResult> {
  const { tenantId, phoneNumberId, parsed, keyword, likelyOptOut } = input;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `${INBOUND_LOCK_PREFIX}${tenantId}:${parsed.messageSid}`,
  ]);

  const { rows: existing } = await client.query(
    `SELECT id FROM sms_messages
      WHERE tenant_id = $1 AND twilio_sid = $2 AND direction = 'inbound'
      LIMIT 1`,
    [tenantId, parsed.messageSid],
  );
  if (existing.length > 0) return { duplicate: true };

  const conversation = await getOrCreateConversation(
    client,
    tenantId,
    phoneNumberId,
    parsed.from,
    newId,
  );

  if (keyword === 'opt_out') {
    await client.query(
      `INSERT INTO dnc_list (id, tenant_id, phone_number, reason, source)
       VALUES ($1, $2, $3, $4, 'sms')
       ON CONFLICT (tenant_id, phone_number) DO NOTHING`,
      [newId(), tenantId, parsed.from, `SMS opt-out: "${parsed.body.trim()}"`],
    );
    await client.query(
      `INSERT INTO sms_consent_log (id, tenant_id, phone_number, action, keyword, source, twilio_sid)
       VALUES ($1, $2, $3, 'opt_out', $4, 'inbound_sms', $5)`,
      [newId(), tenantId, parsed.from, parsed.body.trim(), parsed.messageSid],
    );
  } else if (keyword === 'opt_in') {
    await client.query(
      `INSERT INTO sms_consent_log (id, tenant_id, phone_number, action, keyword, source, twilio_sid)
       VALUES ($1, $2, $3, 'opt_in', $4, 'inbound_sms', $5)`,
      [newId(), tenantId, parsed.from, parsed.body.trim(), parsed.messageSid],
    );
    await liftSmsOptOutDnc(tenantId, parsed.from, client);
  } else if (keyword === 'help') {
    await client.query(
      `INSERT INTO sms_consent_log (id, tenant_id, phone_number, action, keyword, source, twilio_sid)
       VALUES ($1, $2, $3, 'help_request', $4, 'inbound_sms', $5)`,
      [newId(), tenantId, parsed.from, parsed.body.trim(), parsed.messageSid],
    );
  }

  const preview =
    parsed.body.length > 100 ? `${parsed.body.slice(0, 100)}...` : parsed.body;
  await client.query(
    `INSERT INTO sms_messages
       (id, tenant_id, conversation_id, direction, from_number, to_number, body, status, twilio_sid, metadata)
     VALUES ($1, $2, $3, 'inbound', $4, $5, $6, 'received', $7, $8::jsonb)`,
    [
      newId(),
      tenantId,
      conversation.id,
      parsed.from,
      parsed.to,
      parsed.body,
      parsed.messageSid,
      JSON.stringify(inboundMetadata(parsed)),
    ],
  );
  await client.query(
    `UPDATE sms_conversations SET
       last_message_at = NOW(),
       last_message_preview = $1,
       unread_count = unread_count + 1,
       updated_at = NOW(),
       status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
     WHERE id = $2 AND tenant_id = $3`,
    [preview, conversation.id, tenantId],
  );
  await client.query(
    `INSERT INTO sms_conversation_activity_log
       (id, tenant_id, conversation_id, action, actor_user_id, actor_name, details)
     VALUES ($1, $2, $3, 'message_received', NULL, NULL, $4::jsonb)`,
    [newId(), tenantId, conversation.id, JSON.stringify({ from: parsed.from })],
  );
  if (likelyOptOut) {
    await client.query(
      `INSERT INTO sms_conversation_activity_log
         (id, tenant_id, conversation_id, action, actor_user_id, actor_name, details)
       VALUES ($1, $2, $3, 'likely_opt_out', NULL, NULL, $4::jsonb)`,
      [newId(), tenantId, conversation.id, JSON.stringify({ likely_opt_out: true })],
    );
  }

  return { duplicate: false, conversation };
}

export const postgresSmsInboundStore: SmsInboundStore = {
  persistInbound(input) {
    return withTenantClient(input.tenantId, (client) =>
      persistInboundOnClient(client, input, randomUUID),
    );
  },
};

async function defaultTryRecordCsat(
  tenantId: string,
  from: string,
  body: string,
): Promise<{ handled: true; csat: { id: string } } | { handled: false }> {
  const csat = await import('../../analytics/CsatSurveyService');
  return csat.tryRecordSmsCsatResponse(tenantId, from, body);
}

async function defaultMarkCsatOptedOut(tenantId: string, from: string): Promise<unknown> {
  const csat = await import('../../analytics/CsatSurveyService');
  return csat.markCsatOptedOut(tenantId, from);
}

export const defaultSmsInboundDeps: Omit<SmsInboundDeps, 'lookupByTo'> = {
  store: postgresSmsInboundStore,
  isOptOut: isSmsOptOut,
  isOptIn: isSmsOptIn,
  isHelp: isSmsHelp,
  isLikelyOptOut: isLikelySmsOptOut,
  tryRecordCsat: defaultTryRecordCsat,
  markCsatOptedOut: defaultMarkCsatOptedOut,
  evaluateAutoReplies: (tenantId, body, phoneNumberId) =>
    evaluateAutoReplies(tenantId, body, phoneNumberId),
  evaluateAssignmentRules: (tenantId, conversation, body) =>
    evaluateAssignmentRules(tenantId, conversation as SmsConversation, body),
  updateConversation: (tenantId, conversationId, updates) =>
    updateConversation(tenantId, conversationId, updates),
  logActivity: (tenantId, conversationId, action, actorUserId, actorName, details) =>
    logActivity(tenantId, conversationId, action, actorUserId, actorName, details),
  saveAutoReply: async ({ tenantId, conversationId, fromNumber, toNumber, body }) => {
    await saveMessage(tenantId, conversationId, {
      direction: 'outbound',
      fromNumber,
      toNumber,
      body,
      status: 'sent',
      allowOutsideQuietHours: true,
    });
  },
  logger,
};

function keywordFor(body: string, deps: Pick<SmsInboundDeps, 'isOptOut' | 'isOptIn' | 'isHelp'>): InboundKeyword {
  if (deps.isOptOut(body)) return 'opt_out';
  if (deps.isOptIn(body)) return 'opt_in';
  if (deps.isHelp(body)) return 'help';
  return null;
}

/**
 * Tenant-safe inbound SMS handler. Twilio's `/twilio/sms` adapter parses
 * nothing beyond `req.body` and returns the TwiML this produces.
 *
 * Persist failure of an opt-out (DNC + consent + message) rolls the
 * transaction back, logs at error (tenant id + MessageSid, no phone),
 * sends no auto-reply, and returns HTTP 500 empty TwiML so Twilio retries.
 * A second delivery of the same tenant + MessageSid is a no-op.
 */
export async function handleInboundSms(
  payload: unknown,
  deps: SmsInboundDeps,
): Promise<InboundSmsResult> {
  const parsed = parseInboundSmsPayload(payload);
  if (!parsed) {
    deps.logger.warn('Inbound SMS payload failed validation', { reason: 'invalid_payload' });
    return { twiml: EMPTY_INBOUND_TWIML, httpStatus: 200 };
  }

  deps.logger.info('Inbound SMS received', { from: redactPHI(parsed.from), to: redactPHI(parsed.to) });

  let routing: { tenantId: string; phoneNumberId: string } | null;
  try {
    routing = await deps.lookupByTo(parsed.to);
  } catch (err) {
    deps.logger.error('Inbound SMS routing lookup failed', {
      messageSid: parsed.messageSid,
      error: String(err),
    });
    return { twiml: EMPTY_INBOUND_TWIML, httpStatus: 500 };
  }
  if (!routing) {
    deps.logger.warn('No routing found for inbound SMS', { to: redactPHI(parsed.to) });
    return { twiml: EMPTY_INBOUND_TWIML, httpStatus: 200 };
  }

  const { tenantId, phoneNumberId } = routing;
  const keyword = keywordFor(parsed.body, deps);
  const likelyOptOut = keyword === null && deps.isLikelyOptOut(parsed.body);

  let persist: PersistInboundResult;
  try {
    persist = await deps.store.persistInbound({
      tenantId,
      phoneNumberId,
      parsed,
      keyword,
      likelyOptOut,
    });
  } catch (err) {
    deps.logger.error('Inbound SMS persist failed', {
      tenantId,
      messageSid: parsed.messageSid,
      error: String(err),
    });
    return { twiml: EMPTY_INBOUND_TWIML, httpStatus: 500 };
  }

  if (persist.duplicate) {
    deps.logger.info('Inbound SMS duplicate delivery ignored', {
      tenantId,
      messageSid: parsed.messageSid,
    });
    return { twiml: EMPTY_INBOUND_TWIML, httpStatus: 200, duplicate: true };
  }

  const { conversation } = persist;

  if (keyword === 'opt_out') {
    try {
      await deps.markCsatOptedOut(tenantId, parsed.from);
    } catch (csatErr) {
      deps.logger.warn('Failed to mark CSAT opt-out', { tenantId, error: String(csatErr) });
    }
    deps.logger.info('SMS opt-out processed — added to DNC', {
      tenantId,
      phone: redactPHI(parsed.from),
    });
  } else if (keyword === 'opt_in') {
    deps.logger.info('SMS opt-in processed', { tenantId, phone: redactPHI(parsed.from) });
  }

  let csatHandled = false;
  try {
    const recorded = await deps.tryRecordCsat(tenantId, parsed.from, parsed.body);
    if (recorded.handled) {
      csatHandled = true;
      deps.logger.info('CSAT SMS response recorded', {
        tenantId,
        csatId: recorded.csat.id,
      });
    }
  } catch (csatErr) {
    deps.logger.warn('CSAT SMS handling failed, falling through to normal flow', {
      tenantId,
      error: String(csatErr),
    });
  }

  let inner = '';
  if (!csatHandled && keyword !== 'opt_out') {
    try {
      const autoReply = await deps.evaluateAutoReplies(tenantId, parsed.body, phoneNumberId);
      if (autoReply) {
        inner = `<Message>${escapeTwimlText(autoReply)}</Message>`;
        try {
          await deps.saveAutoReply({
            tenantId,
            conversationId: conversation.id,
            fromNumber: parsed.to,
            toNumber: parsed.from,
            body: autoReply,
          });
        } catch (err) {
          deps.logger.error('Inbound SMS auto-reply persist failed', {
            tenantId,
            messageSid: parsed.messageSid,
            error: String(err),
          });
        }
      }
    } catch (err) {
      deps.logger.error('Inbound SMS auto-reply evaluation failed', {
        tenantId,
        messageSid: parsed.messageSid,
        error: String(err),
      });
    }
  }

  if (!conversation.assigneeUserId) {
    try {
      const assignment = await deps.evaluateAssignmentRules(tenantId, conversation, parsed.body);
      if (assignment) {
        await deps.updateConversation(tenantId, conversation.id, {
          assigneeUserId: assignment.userId,
          assigneeTeam: assignment.team,
        });
        await deps.logActivity(tenantId, conversation.id, 'assigned', null, null, {
          team: assignment.team,
          user: assignment.userId,
        });
      }
    } catch (err) {
      deps.logger.error('Inbound SMS assignment failed', {
        tenantId,
        messageSid: parsed.messageSid,
        error: String(err),
      });
    }
  }

  return { twiml: inboundSmsTwiml(inner), httpStatus: 200 };
}
