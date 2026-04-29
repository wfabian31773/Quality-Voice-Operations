import { randomUUID, randomBytes } from 'crypto';
import { getPlatformPool, withTenantContext, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';
import { redactPHI } from '../core/phi/redact';

const logger = createLogger('CSAT_SURVEY');

export type CsatChannel = 'sms' | 'ivr' | 'web' | 'email';
export type CsatStatus = 'pending' | 'responded' | 'expired' | 'failed' | 'opted_out';

export interface CsatTenantSettings {
  enabled: boolean;
  channel: CsatChannel;
  scale: number;
  minDurationSeconds: number;
  smsTemplate: string | null;
}

const DEFAULT_SMS_TEMPLATE =
  'Thanks for calling! How would you rate this call?';

const DEFAULT_SETTINGS: CsatTenantSettings = {
  enabled: false,
  channel: 'sms',
  scale: 5,
  minDurationSeconds: 30,
  smsTemplate: null,
};

export interface CsatRow {
  id: string;
  tenantId: string;
  callSessionId: string;
  requestChannel: CsatChannel;
  responseChannel: CsatChannel | null;
  status: CsatStatus;
  scoreScale: number | null;
  scoreRaw: number | null;
  scoreNormalized: number | null;
  comment: string | null;
  rawResponse: string | null;
  dispatchTo: string | null;
  dispatchToken: string | null;
  requestedAt: Date;
  respondedAt: Date | null;
  expiresAt: Date;
}

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

async function withTenant<T>(tenantId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function rowToCsat(r: Record<string, unknown>): CsatRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    callSessionId: r.call_session_id as string,
    requestChannel: r.request_channel as CsatChannel,
    responseChannel: (r.response_channel as CsatChannel | null) ?? null,
    status: r.status as CsatStatus,
    scoreScale: r.score_scale != null ? Number(r.score_scale) : null,
    scoreRaw: r.score_raw != null ? Number(r.score_raw) : null,
    scoreNormalized: r.score_normalized != null ? Number(r.score_normalized) : null,
    comment: (r.comment as string | null) ?? null,
    rawResponse: (r.raw_response as string | null) ?? null,
    dispatchTo: (r.dispatch_to as string | null) ?? null,
    dispatchToken: (r.dispatch_token as string | null) ?? null,
    requestedAt: new Date(r.requested_at as string),
    respondedAt: r.responded_at ? new Date(r.responded_at as string) : null,
    expiresAt: new Date(r.expires_at as string),
  };
}

/** Read the per-tenant CSAT survey configuration. Falls back to OFF defaults
 *  when the columns are absent (e.g. test fixtures that don't run the
 *  migration) so callers never crash on a missing column. */
export async function getTenantCsatSettings(tenantId: string): Promise<CsatTenantSettings> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT csat_survey_enabled, csat_survey_channel, csat_survey_scale,
              csat_survey_min_duration_seconds, csat_survey_sms_template
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) return { ...DEFAULT_SETTINGS };
    const r = rows[0];
    return {
      enabled: Boolean(r.csat_survey_enabled),
      channel: ((r.csat_survey_channel as CsatChannel | null) ?? 'sms') as CsatChannel,
      scale: Number(r.csat_survey_scale ?? 5),
      minDurationSeconds: Number(r.csat_survey_min_duration_seconds ?? 30),
      smsTemplate: (r.csat_survey_sms_template as string | null) ?? null,
    };
  } catch (err) {
    logger.warn('Failed to load CSAT tenant settings, returning OFF defaults', {
      tenantId,
      error: String(err),
    });
    return { ...DEFAULT_SETTINGS };
  }
}

/** Normalize a raw score onto [0,1] given the survey scale. Both ends of the
 *  scale anchor: a 1 on a 1–5 scale → 0.0, a 5 on a 1–5 scale → 1.0, a 0 on
 *  a 0–10 scale → 0.0, a 10 on a 0–10 scale → 1.0. Returns null if the input
 *  is out of range or the scale is degenerate. */
export function normalizeScore(scoreRaw: number, scale: number): number | null {
  if (!Number.isFinite(scoreRaw) || !Number.isFinite(scale)) return null;
  if (scale < 2 || scale > 10) return null;
  // Treat scale as the *maximum*. We accept both 0-based (0..scale) and
  // 1-based (1..scale) inputs because tenants honestly use both — pick the
  // one that produces a value in [0,1].
  const oneBased = (scoreRaw - 1) / (scale - 1);
  const zeroBased = scoreRaw / scale;
  if (oneBased >= 0 && oneBased <= 1) return Math.round(oneBased * 1000) / 1000;
  if (zeroBased >= 0 && zeroBased <= 1) return Math.round(zeroBased * 1000) / 1000;
  return null;
}

export interface CreateCsatRequestParams {
  tenantId: string;
  callSessionId: string;
  channel: CsatChannel;
  dispatchTo?: string | null;
  dispatchToken?: string | null;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
  /** Survey scale (max). Persisted on the row at creation so downstream
   *  response handlers (web/email/IVR) can normalize the score correctly
   *  without having to know the tenant's settings. Defaults to 5. */
  scale?: number;
}

/** Insert a pending CSAT request row up front. The unique partial index on
 *  call_session_id (status IN pending/responded) means a duplicate dispatch
 *  for the same call returns the existing row instead of creating noise. */
export async function createCsatRequest(params: CreateCsatRequestParams): Promise<CsatRow | null> {
  const id = randomUUID();
  const scale = Number.isFinite(params.scale) && (params.scale as number) >= 2 && (params.scale as number) <= 10
    ? (params.scale as number)
    : 5;
  return withTenant(params.tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO call_csat_responses
         (id, tenant_id, call_session_id, request_channel, status,
          score_scale, dispatch_to, dispatch_token, expires_at, metadata)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, COALESCE($8, NOW() + INTERVAL '7 days'), $9)
       ON CONFLICT (call_session_id) WHERE status IN ('pending', 'responded')
       DO NOTHING
       RETURNING *`,
      [
        id,
        params.tenantId,
        params.callSessionId,
        params.channel,
        scale,
        params.dispatchTo ?? null,
        params.dispatchToken ?? null,
        params.expiresAt ?? null,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
    if (rows.length === 0) {
      // A pending/responded row already exists for this call.
      const { rows: existing } = await client.query(
        `SELECT * FROM call_csat_responses
          WHERE tenant_id = $1 AND call_session_id = $2
            AND status IN ('pending', 'responded')
          ORDER BY requested_at DESC LIMIT 1`,
        [params.tenantId, params.callSessionId],
      );
      return existing.length > 0 ? rowToCsat(existing[0]) : null;
    }
    return rowToCsat(rows[0]);
  });
}

export interface RecordCsatResponseParams {
  tenantId: string;
  csatId?: string;            // when matched by id (web/email link)
  callSessionId?: string;     // when matched by call (server-side admin)
  responseChannel: CsatChannel;
  scoreRaw: number;
  scale: number;
  comment?: string | null;
  rawResponse?: string | null;
}

export async function recordCsatResponse(params: RecordCsatResponseParams): Promise<CsatRow | null> {
  const normalized = normalizeScore(params.scoreRaw, params.scale);
  if (normalized === null) {
    throw new Error(`Invalid CSAT score ${params.scoreRaw} for scale ${params.scale}`);
  }

  return withTenant(params.tenantId, async (client) => {
    let id = params.csatId;

    if (!id && params.callSessionId) {
      const { rows: pending } = await client.query(
        `SELECT id FROM call_csat_responses
          WHERE tenant_id = $1 AND call_session_id = $2 AND status = 'pending'
          ORDER BY requested_at DESC LIMIT 1`,
        [params.tenantId, params.callSessionId],
      );
      if (pending.length === 0) return null;
      id = pending[0].id as string;
    }

    if (!id) return null;

    const { rows } = await client.query(
      `UPDATE call_csat_responses
          SET status            = 'responded',
              response_channel  = $3,
              score_scale       = $4,
              score_raw         = $5,
              score_normalized  = $6,
              comment           = $7,
              raw_response      = $8,
              responded_at      = NOW(),
              updated_at        = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
        RETURNING *`,
      [
        id,
        params.tenantId,
        params.responseChannel,
        params.scale,
        params.scoreRaw,
        normalized,
        params.comment ?? null,
        params.rawResponse ?? null,
      ],
    );
    return rows.length > 0 ? rowToCsat(rows[0]) : null;
  });
}

/** Match the most recent pending SMS-channel CSAT request for `fromNumber`
 *  in this tenant. Returns null if there is no outstanding survey or the
 *  body is not a parseable score. */
export async function tryRecordSmsCsatResponse(
  tenantId: string,
  fromNumber: string,
  body: string,
): Promise<{ handled: true; csat: CsatRow } | { handled: false; reason: string }> {
  const trimmed = body.trim();
  // We only match if the message *starts* with a number — tenants might
  // append a comment ("4 great call!"). Also tolerate a leading rating
  // word ("rate 4", "score 4").
  const match = trimmed.match(/^(?:rate|rating|score)?\s*(\d+(?:\.\d)?)/i);
  if (!match) return { handled: false, reason: 'no_score_in_body' };
  const scoreRaw = parseFloat(match[1]);
  if (!Number.isFinite(scoreRaw) || scoreRaw < 0 || scoreRaw > 10) {
    return { handled: false, reason: 'score_out_of_range' };
  }

  return withTenant(tenantId, async (client) => {
    const { rows: pending } = await client.query(
      `SELECT * FROM call_csat_responses
        WHERE tenant_id = $1
          AND request_channel = 'sms'
          AND status = 'pending'
          AND dispatch_to = $2
          AND expires_at > NOW()
        ORDER BY requested_at DESC LIMIT 1`,
      [tenantId, fromNumber],
    );

    if (pending.length === 0) {
      return { handled: false as const, reason: 'no_pending_survey' };
    }

    const row = pending[0];
    const scale = Number(row.score_scale) > 0
      ? Number(row.score_scale)
      : Number(((row.metadata as Record<string, unknown> | null) ?? {}).scale ?? 5);
    const normalized = normalizeScore(scoreRaw, scale);
    if (normalized === null) {
      return { handled: false as const, reason: 'score_out_of_range_for_scale' };
    }

    // Capture any free-text after the score as the comment.
    const trailing = trimmed.replace(match[0], '').trim();
    const comment = trailing.length > 0 ? trailing.slice(0, 1000) : null;

    const { rows: updated } = await client.query(
      `UPDATE call_csat_responses
          SET status            = 'responded',
              response_channel  = 'sms',
              score_scale       = $3,
              score_raw         = $4,
              score_normalized  = $5,
              comment           = $6,
              raw_response      = $7,
              responded_at      = NOW(),
              updated_at        = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
        RETURNING *`,
      [row.id, tenantId, scale, scoreRaw, normalized, comment, body.slice(0, 1000)],
    );
    if (updated.length === 0) {
      return { handled: false as const, reason: 'race_lost' };
    }
    logger.info('Recorded SMS CSAT response', {
      tenantId,
      csatId: updated[0].id,
      callSessionId: updated[0].call_session_id,
      scoreRaw,
      scoreNormalized: normalized,
    });
    return { handled: true as const, csat: rowToCsat(updated[0]) };
  });
}

/** Mark a survey as opted out (the customer texted STOP). The row stops
 *  blocking new dispatches for the same session and is excluded from
 *  aggregation. */
export async function markCsatOptedOut(tenantId: string, dispatchTo: string): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE call_csat_responses
          SET status = 'opted_out', updated_at = NOW()
        WHERE tenant_id = $1 AND dispatch_to = $2 AND status = 'pending'`,
      [tenantId, dispatchTo],
    );
    return rowCount ?? 0;
  });
}

/** Sweep over expired pending rows. Called from the scheduler. */
export async function expireStaleCsatRequests(): Promise<number> {
  return withPrivilegedClient(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE call_csat_responses
          SET status = 'expired', updated_at = NOW()
        WHERE status = 'pending' AND expires_at <= NOW()`,
    );
    return rowCount ?? 0;
  });
}

export interface AggregatedCsat {
  responseCount: number;
  /** Mean of `score_normalized` (0..1) across responded rows. */
  meanNormalized: number;
  /** `meanNormalized` rescaled to a 0..10 axis to match `avg_quality_score`
   *  so the public benchmark surface is dimensionally consistent. */
  meanOnTen: number;
  /** % of responses that are at the top of the scale (>= 0.8 normalized). */
  topBoxRate: number;
}

/** Aggregate per-tenant CSAT for the GIN aggregation pipeline. Privileged
 *  read; tenant-isolation is enforced by the caller passing in tenantId. */
export async function getTenantCsatAggregate(
  client: DbClient,
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<AggregatedCsat> {
  const { rows } = await client.query(
    `SELECT
       COUNT(*)::int                        AS response_count,
       COALESCE(AVG(score_normalized), 0)::float
                                            AS mean_normalized,
       COALESCE(AVG(CASE WHEN score_normalized >= 0.8 THEN 1.0 ELSE 0.0 END), 0)::float
                                            AS top_box_rate
       FROM call_csat_responses
      WHERE tenant_id = $1
        AND status = 'responded'
        AND responded_at >= $2 AND responded_at < $3`,
    [tenantId, periodStart, periodEnd],
  );
  const r = rows[0] ?? { response_count: 0, mean_normalized: 0, top_box_rate: 0 };
  const meanNormalized = Number(r.mean_normalized || 0);
  return {
    responseCount: Number(r.response_count || 0),
    meanNormalized,
    meanOnTen: Math.round(meanNormalized * 10 * 100) / 100,
    topBoxRate: Number(r.top_box_rate || 0),
  };
}

/** Build the SMS body to send for a CSAT survey. Honors the tenant template
 *  if set, then appends the explicit rating prompt so the customer always
 *  knows what to text back. */
export function buildCsatSmsBody(template: string | null, scale: number): string {
  const base = (template ?? DEFAULT_SMS_TEMPLATE).trim();
  // Cap to 200 chars so the prompt + STOP footer still fit in two segments.
  const trimmed = base.length > 200 ? base.slice(0, 200) : base;
  return `${trimmed} Reply 1-${scale} (1=poor, ${scale}=great). Reply STOP to opt out.`;
}

export interface DispatchSmsCsatParams {
  tenantId: string;
  callSessionId: string;
  callerNumber: string;
  fromNumber: string;
  scale: number;
  template: string | null;
  /** Plug-in SMS sender so this service stays decoupled from Twilio creds.
   *  Returning the SID lets us thread it through onto the row metadata for
   *  later debugging / reconciliation. */
  send: (toNumber: string, fromNumber: string, body: string) => Promise<{ sid?: string }>;
}

/** Convenience wrapper used by the call-completed hook. Inserts the pending
 *  row and dispatches the SMS in one shot. Errors from `send` flip the row
 *  to status='failed' so the dispatch is not silently lost. */
export async function dispatchSmsCsatSurvey(
  params: DispatchSmsCsatParams,
): Promise<{ csat: CsatRow | null; sent: boolean; error?: string }> {
  if (!params.callerNumber || !params.fromNumber) {
    return { csat: null, sent: false, error: 'missing_numbers' };
  }
  const body = buildCsatSmsBody(params.template, params.scale);

  const csat = await createCsatRequest({
    tenantId: params.tenantId,
    callSessionId: params.callSessionId,
    channel: 'sms',
    dispatchTo: params.callerNumber,
    scale: params.scale,
    metadata: { scale: params.scale, fromNumber: params.fromNumber },
  });

  if (!csat) {
    return { csat: null, sent: false, error: 'create_failed' };
  }
  // If we returned a pre-existing row (already responded or already dispatched),
  // do not re-send — the caller already got their survey.
  if (csat.status !== 'pending' || csat.dispatchTo !== params.callerNumber || csat.respondedAt) {
    return { csat, sent: false, error: 'already_dispatched' };
  }

  try {
    const result = await params.send(params.callerNumber, params.fromNumber, body);
    await withTenant(params.tenantId, async (client) => {
      await client.query(
        `UPDATE call_csat_responses
            SET metadata = metadata || $3::jsonb,
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2`,
        [csat.id, params.tenantId, JSON.stringify({ twilio_sid: result.sid ?? null })],
      );
    });
    return { csat, sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to dispatch CSAT SMS', {
      tenantId: params.tenantId,
      callSessionId: params.callSessionId,
      to: redactPHI(params.callerNumber),
      error: message,
    });
    await withTenant(params.tenantId, async (client) => {
      await client.query(
        `UPDATE call_csat_responses
            SET status = 'failed',
                metadata = metadata || $3::jsonb,
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
        [csat.id, params.tenantId, JSON.stringify({ dispatch_error: message })],
      );
    });
    return { csat, sent: false, error: message };
  }
}

/** Issue a single-use opaque token for a web/email survey link. */
export function issueCsatDispatchToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Look up a pending CSAT row by its public dispatch token. Used by the
 *  unauthenticated public form-submit endpoint. */
export async function getCsatByDispatchToken(token: string): Promise<CsatRow | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM call_csat_responses WHERE dispatch_token = $1 LIMIT 1`,
      [token],
    );
    return rows.length > 0 ? rowToCsat(rows[0]) : null;
  });
}

export interface UpdateTenantCsatSettingsInput {
  enabled?: boolean;
  channel?: CsatChannel;
  scale?: number;
  minDurationSeconds?: number;
  smsTemplate?: string | null;
}

/** Validate an update payload before it touches the DB. Returns null on
 *  success, or a human-readable reason on the first invalid field so the
 *  route can return a 400 with a useful message. */
export function validateCsatSettingsUpdate(input: UpdateTenantCsatSettingsInput): string | null {
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  if (input.channel !== undefined) {
    // The DB CHECK on tenants only allows sms/web/email — IVR is captured
    // on response rows but is not a tenant-configurable dispatch channel.
    if (!['sms', 'web', 'email'].includes(input.channel)) {
      return 'channel must be one of: sms, web, email';
    }
  }
  if (input.scale !== undefined) {
    if (!Number.isInteger(input.scale) || input.scale < 2 || input.scale > 10) {
      return 'scale must be an integer between 2 and 10';
    }
  }
  if (input.minDurationSeconds !== undefined) {
    if (!Number.isInteger(input.minDurationSeconds) || input.minDurationSeconds < 5 || input.minDurationSeconds > 600) {
      return 'minDurationSeconds must be an integer between 5 and 600';
    }
  }
  if (input.smsTemplate !== undefined && input.smsTemplate !== null) {
    if (typeof input.smsTemplate !== 'string') return 'smsTemplate must be a string or null';
    if (input.smsTemplate.length > 320) return 'smsTemplate must be <= 320 characters';
  }
  return null;
}

/** Patch the per-tenant CSAT survey configuration. Only the fields present
 *  in `input` are touched. Returns the post-update settings so the caller
 *  can echo them back to the UI without a round-trip. */
export async function updateTenantCsatSettings(
  tenantId: string,
  input: UpdateTenantCsatSettingsInput,
): Promise<CsatTenantSettings> {
  const updates: string[] = [];
  const values: unknown[] = [tenantId];

  if (input.enabled !== undefined) {
    values.push(input.enabled);
    updates.push(`csat_survey_enabled = $${values.length}`);
  }
  if (input.channel !== undefined) {
    values.push(input.channel);
    updates.push(`csat_survey_channel = $${values.length}`);
  }
  if (input.scale !== undefined) {
    values.push(input.scale);
    updates.push(`csat_survey_scale = $${values.length}`);
  }
  if (input.minDurationSeconds !== undefined) {
    values.push(input.minDurationSeconds);
    updates.push(`csat_survey_min_duration_seconds = $${values.length}`);
  }
  if (input.smsTemplate !== undefined) {
    // Persist a null when the tenant explicitly cleared the override so
    // the SMS body falls back to the service-default prompt.
    const normalized = input.smsTemplate === null ? null
      : input.smsTemplate.trim().length === 0 ? null
      : input.smsTemplate;
    values.push(normalized);
    updates.push(`csat_survey_sms_template = $${values.length}`);
  }

  if (updates.length === 0) {
    // Nothing to write — return the current settings unchanged.
    return getTenantCsatSettings(tenantId);
  }

  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE tenants SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1`,
      values,
    );
  });

  logger.info('Updated CSAT tenant settings', {
    tenantId,
    fields: updates.length,
  });

  return getTenantCsatSettings(tenantId);
}

/** Tenant-scoped read for admin views: most recent CSAT rows for display in
 *  the quality dashboard. */
export async function listRecentCsatResponses(
  tenantId: string,
  limit = 50,
): Promise<CsatRow[]> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM call_csat_responses
        WHERE tenant_id = $1 AND status = 'responded'
        ORDER BY responded_at DESC LIMIT $2`,
      [tenantId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(rowToCsat);
  });
}
