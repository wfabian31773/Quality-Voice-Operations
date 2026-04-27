import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireApiKeyOrJwt } from '../middleware/apiKeyAuth';
import { requireApiKeyPermission } from '../middleware/apiKeyScope';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import {
  CallBackfillEventV1Schema,
  CallCompletionEventV1Schema,
  INGEST_BACKFILL_WINDOW_DAYS,
  INGEST_FRESH_WINDOW_DAYS,
  TicketCreationEventV1Schema,
} from '../../../shared/ingest/eventTypes';
import type {
  CallBackfillEventV1,
  CallCompletionEventV1,
  TicketCreationEventV1,
} from '../../../shared/ingest/eventTypes';

const router = Router();
const logger = createLogger('INGEST_API');

const apiKeyAuth = requireApiKeyOrJwt(requireAuth);

const ingestLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 100,
  message: 'Ingest rate limit exceeded. Please try again later.',
  keyGenerator: (req) => {
    const userId = req.user?.userId ?? 'anon';
    const tenantId = req.user?.tenantId ?? 'unknown';
    return `ingest:${tenantId}:${userId}`;
  },
});

async function tryRecordIngestEvent(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> },
  orgId: string,
  idempotencyKey: string,
  eventType: string,
  eventVersion: string,
  source: string,
  payload: unknown,
  status: string,
  errorMessage?: string,
): Promise<'inserted' | 'duplicate'> {
  const { rows } = await client.query(
    `INSERT INTO ingest_events (org_id, idempotency_key, event_type, event_version, source, payload, status, error_message, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [orgId, idempotencyKey, eventType, eventVersion, source, JSON.stringify(payload), status, errorMessage ?? null, status === 'processed' ? new Date().toISOString() : null],
  );
  return rows.length > 0 ? 'inserted' : 'duplicate';
}

async function updateIngestEventStatus(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  orgId: string,
  idempotencyKey: string,
  status: string,
  errorMessage?: string,
): Promise<void> {
  await client.query(
    `UPDATE ingest_events SET status = $3, error_message = $4, processed_at = $5
     WHERE org_id = $1 AND idempotency_key = $2`,
    [orgId, idempotencyKey, status, errorMessage ?? null, status === 'processed' ? new Date().toISOString() : null],
  );
}

async function resolveAgentByRemoteId(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  tenantId: string,
  remoteAgentId: string,
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT id FROM agents
     WHERE tenant_id = $1 AND remote_agent_id = $2 AND execution_mode = 'federated'
     LIMIT 1`,
    [tenantId, remoteAgentId],
  );
  return rows.length > 0 ? (rows[0].id as string) : null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Returns the age (in whole days) of `startTimeIso` relative to `now`. Returns
 * a negative number when the timestamp is in the future, which we always
 * reject.
 */
function ageInDays(startTimeIso: string, now: Date = new Date()): number {
  const t = Date.parse(startTimeIso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / MS_PER_DAY;
}

interface ProcessCallEventResult {
  status: 201 | 500;
  body: Record<string, unknown>;
}

/**
 * Shared post-validation pipeline for both `/v1/ingest/calls` and
 * `/v1/ingest/calls/backfill`. The caller is responsible for window
 * enforcement, schema validation, attestation handling, and recording the
 * `ingest_events` audit row in `received` state. This helper performs the
 * domain writes (call_sessions, quality, costs, usage, daily rollups) and
 * marks the audit row as `processed` on success / `failed` on error.
 */
async function persistCallEvent(
  tenantId: string,
  event: CallCompletionEventV1,
  source: 'remix' | 'remix-backfill',
): Promise<ProcessCallEventResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const agentId = await resolveAgentByRemoteId(
      client as unknown as Parameters<typeof resolveAgentByRemoteId>[0],
      tenantId,
      event.agent_remote_id,
    );

    const lifecycleState = event.transferred_to_human ? 'ESCALATED' : 'CALL_COMPLETED';

    const contextJson = JSON.stringify({
      transcript: event.transcript,
      summary: event.summary ?? null,
      recording_url: event.recording_url ?? null,
      costs: event.costs,
      tokens: event.tokens ?? null,
      telemetry: event.telemetry ?? null,
      source,
      status: event.status,
    });

    // Fetch any pre-existing call_session for this external_id together with
    // the columns we need to compute correction deltas. A row only exists when
    // an earlier ingest (or backfill) for the same external_id has already
    // landed; in that case this call is a CORRECTION and the per-day usage
    // aggregates must be adjusted by the *delta*, not the full event amount,
    // to avoid double-counting calls/minutes/cost on the second submission.
    const { rows: existingCallRows } = await client.query(
      `SELECT id, total_cost_cents, duration_seconds,
              start_time::text AS start_time, direction
         FROM call_sessions WHERE tenant_id = $1 AND external_id = $2`,
      [tenantId, event.external_id],
    );
    const existingCall = existingCallRows[0] as
      | {
          id: string;
          total_cost_cents: number | string;
          duration_seconds: number | string;
          start_time: string;
          direction: string;
        }
      | undefined;

    // The previous openai cost lives in `conversation_costs.llm_cost_cents`
    // (the `costs` jsonb on call_sessions only carries the rolled-up totals),
    // so fetch it explicitly for the ai_minutes usage delta.
    let existingOpenaiCents = 0;
    if (existingCall) {
      const { rows: existingCostRows } = await client.query(
        `SELECT llm_cost_cents FROM conversation_costs
          WHERE tenant_id = $1 AND call_session_id = $2 LIMIT 1`,
        [tenantId, existingCall.id],
      );
      if (existingCostRows[0]) {
        existingOpenaiCents = Number((existingCostRows[0] as { llm_cost_cents: number | string }).llm_cost_cents);
      }
    }

    let sessionRows: { id: unknown }[];
    if (existingCall) {
      const updated = await client.query(
        `UPDATE call_sessions SET
          call_sid = $3, agent_id = COALESCE($4, agent_id),
          lifecycle_state = $5::call_lifecycle_state,
          end_time = $6, duration_seconds = $7, total_cost_cents = $8,
          context = $9, escalation_reason = $10, updated_at = NOW()
        WHERE tenant_id = $1 AND external_id = $2
        RETURNING id`,
        [
          tenantId, event.external_id, event.twilio_sid ?? null, agentId,
          lifecycleState, event.end_time, event.duration_seconds,
          event.costs.total_cents, contextJson, event.escalation_reason ?? null,
        ],
      );
      sessionRows = updated.rows as { id: unknown }[];
    } else {
      const inserted = await client.query(
        `INSERT INTO call_sessions (
          tenant_id, agent_id, call_sid, direction,
          caller_number, called_number, lifecycle_state,
          start_time, end_time, duration_seconds, total_cost_cents,
          external_id, context, environment, escalation_reason
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::call_lifecycle_state, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id`,
        [
          tenantId, agentId, event.twilio_sid ?? null, event.direction,
          event.from_number, event.to_number, lifecycleState,
          event.start_time, event.end_time, event.duration_seconds,
          event.costs.total_cents, event.external_id, contextJson,
          'production', event.escalation_reason ?? null,
        ],
      );
      sessionRows = inserted.rows as { id: unknown }[];
    }

    const callSessionId = sessionRows[0].id as string;

    if (event.quality?.score !== undefined && event.quality.score !== null) {
      const { rows: existingQuality } = await client.query(
        `SELECT id FROM call_quality_scores WHERE call_session_id = $1 AND scored_by = 'remix-grading' LIMIT 1`,
        [callSessionId],
      );
      const qualityFeedback = JSON.stringify({
        sentiment: event.quality.sentiment ?? null,
        agent_outcome: event.quality.agent_outcome ?? null,
        analysis: event.quality.analysis ?? null,
        source,
      });
      if (existingQuality.length > 0) {
        await client.query(
          `UPDATE call_quality_scores SET score = $1, feedback = $2, scored_at = NOW()
           WHERE id = $3`,
          [event.quality.score, qualityFeedback, existingQuality[0].id],
        );
      } else {
        await client.query(
          `INSERT INTO call_quality_scores (tenant_id, call_session_id, score, feedback, scored_by)
           VALUES ($1, $2, $3, $4, 'remix-grading')`,
          [tenantId, callSessionId, event.quality.score, qualityFeedback],
        );
      }
    }

    const newAiMinutes = Math.ceil(event.duration_seconds / 60);
    const oldAiMinutes = existingCall
      ? Math.ceil(Number(existingCall.duration_seconds) / 60)
      : 0;

    await client.query(
      `INSERT INTO conversation_costs (
        tenant_id, call_session_id, stt_cost_cents, llm_cost_cents, tts_cost_cents,
        infra_cost_cents, total_cost_cents, model_used,
        input_tokens, output_tokens, cache_hits, cache_misses, prompt_tokens_saved
      ) VALUES ($1, $2, 0, $3, 0, $4, $5, 'gpt-4o-realtime', $6, $7, 0, 0, 0)
      ON CONFLICT (tenant_id, call_session_id) DO UPDATE SET
        llm_cost_cents = EXCLUDED.llm_cost_cents,
        infra_cost_cents = EXCLUDED.infra_cost_cents,
        total_cost_cents = EXCLUDED.total_cost_cents,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        updated_at = NOW()`,
      [
        tenantId,
        callSessionId,
        event.costs.openai_cents,
        event.costs.twilio_cents,
        event.costs.total_cents,
        (event.tokens?.input_audio ?? 0) + (event.tokens?.input_text ?? 0),
        (event.tokens?.output_audio ?? 0) + (event.tokens?.output_text ?? 0),
      ],
    );

    // -----------------------------------------------------------------------
    // Daily usage rollups — DELTA application
    // -----------------------------------------------------------------------
    // For new calls: increment counts + minutes + cost by the full event.
    // For corrections (same external_id re-issued with a fresh idempotency
    // token): increment by the delta only — the call itself is not new, so
    // `quantity` / `total_calls` get +0, and minutes/cost get
    // (new − old). This is what makes the backfill endpoint safe for issuing
    // restated figures without inflating billing aggregates.
    //
    // If a correction also moves the call to a different calendar day (rare
    // but possible), aggregates can drift because the OLD day's bucket still
    // counts the call. We log a warning so finance can investigate; we do not
    // attempt cross-day rebalancing inline because it doubles the SQL load
    // for what should be an exceptional case.
    const isCorrection = !!existingCall;
    const oldCallDate = existingCall ? existingCall.start_time.slice(0, 10) : null;
    const callDate = event.start_time.slice(0, 10);
    if (isCorrection && oldCallDate && oldCallDate !== callDate) {
      logger.warn('Backfill correction shifted call across calendar days', {
        tenantId,
        externalId: event.external_id,
        oldDate: oldCallDate,
        newDate: callDate,
        source,
      });
    }

    const callsDelta = isCorrection ? 0 : 1;
    const totalCostDelta = isCorrection
      ? event.costs.total_cents - Number(existingCall.total_cost_cents)
      : event.costs.total_cents;
    const minutesDelta = isCorrection
      ? newAiMinutes - oldAiMinutes
      : newAiMinutes;
    const openaiDelta = isCorrection
      ? event.costs.openai_cents - existingOpenaiCents
      : event.costs.openai_cents;

    const metricType = event.direction === 'inbound' ? 'calls_inbound' : 'calls_outbound';
    const periodStart = `${callDate}T00:00:00Z`;
    const periodEnd = `${callDate}T23:59:59Z`;

    await client.query(
      `INSERT INTO usage_metrics (tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
       VALUES ($1, $2::usage_metric_type, $3, $4, $5, $6, $6)
       ON CONFLICT (tenant_id, metric_type, period_start) DO UPDATE SET
         quantity = usage_metrics.quantity + $5,
         total_cost_cents = usage_metrics.total_cost_cents + $6,
         updated_at = NOW()`,
      [tenantId, metricType, periodStart, periodEnd, callsDelta, totalCostDelta],
    );

    await client.query(
      `INSERT INTO usage_metrics (tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
       VALUES ($1, 'ai_minutes'::usage_metric_type, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, metric_type, period_start) DO UPDATE SET
         quantity = usage_metrics.quantity + $4,
         total_cost_cents = usage_metrics.total_cost_cents + $6,
         updated_at = NOW()`,
      [tenantId, periodStart, periodEnd, minutesDelta, openaiDelta, openaiDelta],
    );

    await client.query(
      `INSERT INTO daily_org_usage (tenant_id, date, total_calls, total_ai_minutes, total_cost_cents)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, date) DO UPDATE SET
         total_calls = daily_org_usage.total_calls + $3,
         total_ai_minutes = daily_org_usage.total_ai_minutes + $4,
         total_cost_cents = daily_org_usage.total_cost_cents + $5`,
      [tenantId, callDate, callsDelta, minutesDelta, totalCostDelta],
    );

    if (agentId) {
      await client.query(
        `UPDATE agents SET last_sync_at = NOW() WHERE id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      );
    }

    await updateIngestEventStatus(client, tenantId, event.idempotency_key, 'processed');

    await client.query('COMMIT');

    logger.info('Call ingest processed', {
      tenantId,
      callSessionId,
      externalId: event.external_id,
      agentRemoteId: event.agent_remote_id,
      source,
    });

    return {
      status: 201,
      body: {
        status: 'processed',
        call_session_id: callSessionId,
        idempotency_key: event.idempotency_key,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Call ingest failed', { tenantId, error: String(err), source });

    try {
      const errClient = await pool.connect();
      try {
        await errClient.query('BEGIN');
        await withTenantContext(errClient, tenantId, async () => {});
        await updateIngestEventStatus(errClient, tenantId, event.idempotency_key, 'failed', String(err));
        await errClient.query('COMMIT');
      } finally {
        errClient.release();
      }
    } catch { /* best effort */ }

    return {
      status: 500,
      body: { error: 'Failed to process call event' },
    };
  } finally {
    client.release();
  }
}

/**
 * Records an ingest_events row in `received` state and returns whether the
 * record was inserted or skipped because it duplicates an existing key.
 *
 * Idempotency is keyed on `(tenant_id, idempotency_key)` only — never on
 * `external_id` — so an operator can re-issue corrections for the same call
 * by varying the idempotency token. This is the contract documented for the
 * `/v1/ingest/calls/backfill` endpoint.
 */
async function recordReceivedEvent(
  tenantId: string,
  event: CallCompletionEventV1,
  source: 'remix' | 'remix-backfill',
): Promise<{ ok: true; duplicate: boolean } | { ok: false; error: string }> {
  const pool = getPlatformPool();
  const auditClient = await pool.connect();
  try {
    await auditClient.query('BEGIN');
    await withTenantContext(auditClient, tenantId, async () => {});
    const insertResult = await tryRecordIngestEvent(
      auditClient as Parameters<typeof tryRecordIngestEvent>[0],
      tenantId,
      event.idempotency_key,
      event.event_type,
      event.version,
      source,
      event,
      'received',
    );
    await auditClient.query('COMMIT');
    return { ok: true, duplicate: insertResult === 'duplicate' };
  } catch (err) {
    await auditClient.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record ingest event', { tenantId, error: String(err), source });
    return { ok: false, error: String(err) };
  } finally {
    auditClient.release();
  }
}

router.post(
  '/v1/ingest/calls',
  apiKeyAuth,
  ingestLimiter,
  requireApiKeyPermission('write'),
  async (req: Request, res: Response) => {
    req.skipAuditMutation = true;
    const tenantId = req.user!.tenantId;

    const parseResult = CallCompletionEventV1Schema.safeParse(req.body);
    if (!parseResult.success) {
      logger.warn('Invalid call ingest payload', { tenantId, errors: parseResult.error.flatten() });
      return res.status(422).json({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const event: CallCompletionEventV1 = parseResult.data;

    if (event.tenant_id !== tenantId) {
      return res.status(403).json({ error: 'Tenant ID in payload does not match authenticated tenant' });
    }

    // Live ingest only accepts events whose call started within the last
    // INGEST_FRESH_WINDOW_DAYS days. Anything older must be sent via
    // /v1/ingest/calls/backfill with an explicit attestation block. Future
    // timestamps are also rejected — a clock-skew tolerance of 1 day allows
    // upstream systems to be slightly fast without erroring.
    const age = ageInDays(event.start_time);
    if (age > INGEST_FRESH_WINDOW_DAYS) {
      logger.warn('Live ingest rejected: event too old', {
        tenantId,
        externalId: event.external_id,
        ageDays: age,
      });
      return res.status(422).json({
        error: 'Event too old for live ingest',
        details: {
          start_time: event.start_time,
          age_days: Math.round(age * 100) / 100,
          fresh_window_days: INGEST_FRESH_WINDOW_DAYS,
          backfill_window_days: INGEST_BACKFILL_WINDOW_DAYS,
          backfill_endpoint: '/v1/ingest/calls/backfill',
        },
      });
    }
    if (age < -1) {
      logger.warn('Live ingest rejected: event in the future', {
        tenantId,
        externalId: event.external_id,
        ageDays: age,
      });
      return res.status(422).json({
        error: 'Event start_time is in the future',
        details: { start_time: event.start_time },
      });
    }

    const recorded = await recordReceivedEvent(tenantId, event, 'remix');
    if (!recorded.ok) {
      return res.status(500).json({ error: 'Failed to record ingest event' });
    }
    if (recorded.duplicate) {
      return res.status(409).json({ error: 'Duplicate event', idempotency_key: event.idempotency_key });
    }

    const result = await persistCallEvent(tenantId, event, 'remix');
    return res.status(result.status).json(result.body);
  },
);

/**
 * Backfill endpoint for federated call ingestion (BL-041).
 *
 * Accepts call.completed events whose `start_time` is older than the live
 * window (INGEST_FRESH_WINDOW_DAYS) but within INGEST_BACKFILL_WINDOW_DAYS.
 * Requires a `backfill_attestation` block — the operator's signed
 * acknowledgement that historical figures (usage_metrics, daily_org_usage,
 * billing rollups) will be adjusted retroactively.
 *
 * Idempotency is keyed on `(tenant_id, idempotency_key)` only, never on
 * `external_id`. This lets an operator re-issue a corrected backfill for the
 * same external_id by supplying a fresh idempotency token.
 */
router.post(
  '/v1/ingest/calls/backfill',
  apiKeyAuth,
  ingestLimiter,
  requireApiKeyPermission('write'),
  async (req: Request, res: Response) => {
    req.skipAuditMutation = true;
    const tenantId = req.user!.tenantId;

    const parseResult = CallBackfillEventV1Schema.safeParse(req.body);
    if (!parseResult.success) {
      logger.warn('Invalid call backfill payload', {
        tenantId,
        errors: parseResult.error.flatten(),
      });
      return res.status(422).json({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const event: CallBackfillEventV1 = parseResult.data;

    if (event.tenant_id !== tenantId) {
      return res.status(403).json({
        error: 'Tenant ID in payload does not match authenticated tenant',
      });
    }

    const age = ageInDays(event.start_time);
    if (age > INGEST_BACKFILL_WINDOW_DAYS) {
      logger.warn('Backfill rejected: event beyond backfill window', {
        tenantId,
        externalId: event.external_id,
        ageDays: age,
      });
      return res.status(422).json({
        error: 'Event too old for backfill',
        details: {
          start_time: event.start_time,
          age_days: Math.round(age * 100) / 100,
          backfill_window_days: INGEST_BACKFILL_WINDOW_DAYS,
        },
      });
    }
    // Backfill is for OLD events only — anything still inside the live
    // window must go through `/v1/ingest/calls`. The boundary is exact and
    // non-overlapping with the live endpoint:
    //   live: accepts age <= INGEST_FRESH_WINDOW_DAYS
    //   backfill: accepts age >  INGEST_FRESH_WINDOW_DAYS
    // No 1-day skew slack here: an attestation block must always represent
    // a genuine after-the-fact correction, never a live event that happened
    // to hit the wrong route.
    if (age <= INGEST_FRESH_WINDOW_DAYS) {
      logger.warn('Backfill rejected: event still inside live window', {
        tenantId,
        externalId: event.external_id,
        ageDays: age,
      });
      return res.status(422).json({
        error: 'Event is within the live ingest window — use /v1/ingest/calls instead',
        details: {
          start_time: event.start_time,
          age_days: Math.round(age * 100) / 100,
          fresh_window_days: INGEST_FRESH_WINDOW_DAYS,
          live_endpoint: '/v1/ingest/calls',
        },
      });
    }
    if (age < -1) {
      logger.warn('Backfill rejected: event in the future', {
        tenantId,
        externalId: event.external_id,
        ageDays: age,
      });
      return res.status(422).json({
        error: 'Event start_time is in the future',
        details: { start_time: event.start_time },
      });
    }

    logger.info('Call backfill accepted', {
      tenantId,
      externalId: event.external_id,
      ageDays: Math.round(age * 100) / 100,
      attestedBy: event.backfill_attestation.attested_by,
      reason: event.backfill_attestation.reason.slice(0, 80),
    });

    const recorded = await recordReceivedEvent(tenantId, event, 'remix-backfill');
    if (!recorded.ok) {
      return res.status(500).json({ error: 'Failed to record ingest event' });
    }
    if (recorded.duplicate) {
      return res
        .status(409)
        .json({ error: 'Duplicate event', idempotency_key: event.idempotency_key });
    }

    const result = await persistCallEvent(tenantId, event, 'remix-backfill');
    if (result.status === 201) {
      return res.status(201).json({
        ...result.body,
        backfill: true,
        age_days: Math.round(age * 100) / 100,
      });
    }
    return res.status(result.status).json(result.body);
  },
);

router.post(
  '/v1/ingest/tickets',
  apiKeyAuth,
  ingestLimiter,
  requireApiKeyPermission('write'),
  async (req: Request, res: Response) => {
    req.skipAuditMutation = true;
    const tenantId = req.user!.tenantId;

    const parseResult = TicketCreationEventV1Schema.safeParse(req.body);
    if (!parseResult.success) {
      logger.warn('Invalid ticket ingest payload', { tenantId, errors: parseResult.error.flatten() });
      return res.status(422).json({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const event: TicketCreationEventV1 = parseResult.data;

    if (event.tenant_id !== tenantId) {
      return res.status(403).json({ error: 'Tenant ID in payload does not match authenticated tenant' });
    }

    const pool = getPlatformPool();

    const auditClient = await pool.connect();
    try {
      await auditClient.query('BEGIN');
      await withTenantContext(auditClient, tenantId, async () => {});
      const insertResult = await tryRecordIngestEvent(
        auditClient as Parameters<typeof tryRecordIngestEvent>[0],
        tenantId,
        event.idempotency_key,
        event.event_type,
        event.version,
        'remix',
        event,
        'received',
      );
      await auditClient.query('COMMIT');
      if (insertResult === 'duplicate') {
        return res.status(409).json({ error: 'Duplicate event', idempotency_key: event.idempotency_key });
      }
    } catch (err) {
      await auditClient.query('ROLLBACK').catch(() => {});
      logger.error('Failed to record ticket ingest event', { tenantId, error: String(err) });
      return res.status(500).json({ error: 'Failed to record ingest event' });
    } finally {
      auditClient.release();
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      let callId: string | null = null;
      if (event.call_external_id) {
        const { rows: callRows } = await client.query(
          `SELECT id FROM call_sessions WHERE tenant_id = $1 AND external_id = $2 LIMIT 1`,
          [tenantId, event.call_external_id],
        );
        if (callRows.length > 0) {
          callId = callRows[0].id as string;
        }
      }

      const patientParts = [event.patient_first_name, event.patient_last_name].filter(Boolean);
      const contactInfo = patientParts.length > 0 ? `Patient: ${patientParts.join(' ')}` : '';
      const fullDescription = [
        event.description,
        contactInfo ? `\n\n${contactInfo}` : '',
        event.external_number ? `\nPhone: ${event.external_number}` : '',
      ].join('');

      const { rows: ticketRows } = await client.query(
        `INSERT INTO tickets (tenant_id, call_id, subject, description, priority, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'open', $6)
         RETURNING id`,
        [
          tenantId,
          callId,
          event.subject,
          fullDescription,
          event.priority,
          event.created_at,
        ],
      );

      const ticketId = ticketRows[0].id as string;

      const agentId = await resolveAgentByRemoteId(
        client as unknown as Parameters<typeof resolveAgentByRemoteId>[0],
        tenantId,
        event.agent_remote_id,
      );

      if (agentId) {
        await client.query(
          `UPDATE agents SET last_sync_at = NOW() WHERE id = $1 AND tenant_id = $2`,
          [agentId, tenantId],
        );
      }

      await updateIngestEventStatus(client, tenantId, event.idempotency_key, 'processed');

      await client.query('COMMIT');

      logger.info('Ticket ingest processed', {
        tenantId,
        ticketId,
        callId: callId ?? undefined,
        agentRemoteId: event.agent_remote_id,
      });

      return res.status(201).json({
        status: 'processed',
        ticket_id: ticketId,
        idempotency_key: event.idempotency_key,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Ticket ingest failed', { tenantId, error: String(err) });

      try {
        const errClient = await pool.connect();
        try {
          await errClient.query('BEGIN');
          await withTenantContext(errClient, tenantId, async () => {});
          await updateIngestEventStatus(errClient, tenantId, event.idempotency_key, 'failed', String(err));
          await errClient.query('COMMIT');
        } finally {
          errClient.release();
        }
      } catch { /* best effort */ }

      return res.status(500).json({ error: 'Failed to process ticket event' });
    } finally {
      client.release();
    }
  },
);

router.get(
  '/v1/ingest/status',
  apiKeyAuth,
  ingestLimiter,
  requireApiKeyPermission('read-only'),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const { rows } = await client.query(
        `SELECT
           event_type,
           status,
           COUNT(*) as count,
           MAX(created_at) as latest
         FROM ingest_events
         WHERE org_id = $1
         GROUP BY event_type, status
         ORDER BY event_type, status`,
        [tenantId],
      );

      await client.query('COMMIT');
      return res.json({ tenant_id: tenantId, event_stats: rows });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Ingest status failed', { tenantId, error: String(err) });
      return res.status(500).json({ error: 'Failed to get ingest status' });
    } finally {
      client.release();
    }
  },
);

export default router;
