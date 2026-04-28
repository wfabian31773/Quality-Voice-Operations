import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
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
 * Path to the manual rebalancing runbook surfaced to finance/ops in every
 * cross-day backfill alert. Stored as a constant so the route handler, the
 * Operations dashboard, and the test suite all reference the same canonical
 * location instead of drifting copy-pasted strings.
 */
export const BACKFILL_CROSS_DAY_RUNBOOK =
  'docs/runbooks/billing-backfill-cross-day-rebalance.md';

interface CrossDayShift {
  externalId: string;
  oldDate: string;
  newDate: string;
  callSessionId: string;
  source: 'remix' | 'remix-backfill';
  /**
   * `rebalanced` — the OLD-day rollup rows existed and were debited in the
   *                same ingest transaction (the overwhelmingly common path).
   * `skipped`    — at least one OLD-day rollup row (`usage_metrics` for the
   *                old direction, `usage_metrics` for ai_minutes, or
   *                `daily_org_usage`) was missing. We refused to issue the
   *                negative-quantity upsert (which would have created a row
   *                with a NEGATIVE quantity that downstream invoicing would
   *                have to special-case) and instead emit a finance alert so
   *                ops can manually rebalance off the runbook.
   */
  kind: 'rebalanced' | 'skipped';
  /** Per-table missing-row breakdown when `kind === 'skipped'`. */
  missingRollups?: { calls: boolean; minutes: boolean; daily: boolean };
}

/**
 * Best-effort write of a finance-visible alert when a backfill correction
 * shifts an existing call into a different calendar day.
 *
 * Two flavours, one helper:
 *
 *   * `kind: 'rebalanced'` — the OLD-day rollup rows existed and were
 *     auto-debited inside the ingest txn. The alert is purely informational
 *     (severity `info`); finance just verifies the auto-rebalance landed.
 *
 *   * `kind: 'skipped'` — at least one OLD-day rollup row was missing
 *     (e.g. the call_session pre-dated the rollup tables, or a row was
 *     deleted out of band). We refused to write the negative-quantity
 *     debit, so finance has to rebalance manually off the runbook. The
 *     alert is `billing_backfill_cross_day_skipped` at severity `warning`.
 *
 * Runs OUTSIDE the ingest transaction with its own connection so a failure
 * here never rolls back the actual call upsert. The runbook URL is included
 * in `metadata.runbook_url` for the Operations alerts UI to link to.
 */
async function recordBackfillCrossDayAlert(
  tenantId: string,
  shift: CrossDayShift,
): Promise<void> {
  const pool = getPlatformPool();
  const isSkipped = shift.kind === 'skipped';
  const alertType = isSkipped
    ? 'billing_backfill_cross_day_skipped'
    : 'billing_backfill_cross_day';
  const severity = isSkipped ? 'warning' : 'info';
  const message = isSkipped
    ? `Backfill correction moved call ${shift.externalId} from ${shift.oldDate} to ${shift.newDate}, ` +
      `but at least one OLD-day rollup row (daily_org_usage / usage_metrics) was missing — ` +
      `the auto-rebalance was SKIPPED to avoid creating a negative-quantity usage row. ` +
      `Manual rebalance required: see runbook ${BACKFILL_CROSS_DAY_RUNBOOK}.`
    : `Backfill correction moved call ${shift.externalId} from ${shift.oldDate} to ${shift.newDate}. ` +
      `daily_org_usage and usage_metrics were auto-rebalanced (OLD-day debit + NEW-day credit) in the ` +
      `same ingest transaction — verify only, no manual rebalance needed. See runbook: ${BACKFILL_CROSS_DAY_RUNBOOK}.`;
  const metadata: Record<string, unknown> = {
    tenant_id: tenantId,
    external_id: shift.externalId,
    old_date: shift.oldDate,
    new_date: shift.newDate,
    source: shift.source,
    auto_rebalanced: !isSkipped,
    runbook_url: BACKFILL_CROSS_DAY_RUNBOOK,
  };
  if (isSkipped && shift.missingRollups) {
    metadata.missing_old_rollups = shift.missingRollups;
    metadata.manual_rebalance_required = true;
  }
  try {
    await pool.query(
      `INSERT INTO operations_alerts (tenant_id, type, severity, message, metadata, call_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        alertType,
        severity,
        message,
        JSON.stringify(metadata),
        shift.callSessionId,
      ],
    );
  } catch (err) {
    logger.warn('Failed to insert finance alert for cross-day backfill shift', {
      tenantId,
      externalId: shift.externalId,
      oldDate: shift.oldDate,
      newDate: shift.newDate,
      kind: shift.kind,
      error: String(err),
    });
  }
}

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
      // Persist the corrected `start_time` too. Without this, a follow-up
      // correction for the same external_id would still see the ORIGINAL
      // start_time on the row and (a) keep being treated as cross-day
      // forever, repeatedly debiting the original day each time, and
      // (b) contradict the runbook claim that call_sessions reflects the
      // post-correction temporal attribution.
      const updated = await client.query(
        `UPDATE call_sessions SET
          call_sid = $3, agent_id = COALESCE($4, agent_id),
          lifecycle_state = $5::call_lifecycle_state,
          start_time = $6, end_time = $7, duration_seconds = $8, total_cost_cents = $9,
          context = $10, escalation_reason = $11, updated_at = NOW()
        WHERE tenant_id = $1 AND external_id = $2
        RETURNING id`,
        [
          tenantId, event.external_id, event.twilio_sid ?? null, agentId,
          lifecycleState, event.start_time, event.end_time, event.duration_seconds,
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
    // Three cases drive the per-day deltas applied to `usage_metrics` and
    // `daily_org_usage`:
    //
    //   (1) Brand-new call (no prior session row): credit the NEW day with
    //       the full event (+1 call, +new_minutes, +new_cost, +new_openai).
    //
    //   (2) Same-day correction (same external_id, same calendar day): the
    //       call itself is not new, so `total_calls` / `quantity` get +0 and
    //       minutes/cost get the (new − old) delta only. This is what makes
    //       the backfill endpoint safe for issuing restated figures without
    //       inflating billing aggregates.
    //
    //   (3) Cross-day shift (same external_id, different calendar day): the
    //       NEW day is credited the full new amount AND the OLD day is fully
    //       reversed in the same transaction (-1 call, -old_minutes,
    //       -old_cost, -old_openai). This used to require a manual SQL
    //       rebalance off a finance runbook; the alert is now informational
    //       only. Because the work is in the same txn as the call upsert
    //       there is no double-counting window, and replaying the same
    //       correction is idempotent — the duplicate idempotency_key is
    //       caught upstream in `recordReceivedEvent` and `persistCallEvent`
    //       never runs a second time.
    const isCorrection = !!existingCall;
    const oldCallDate = existingCall ? existingCall.start_time.slice(0, 10) : null;
    const callDate = event.start_time.slice(0, 10);
    const isCrossDayShift = isCorrection && oldCallDate !== null && oldCallDate !== callDate;
    let crossDayShift: CrossDayShift | null = null;
    if (isCrossDayShift) {
      logger.info('Backfill correction shifted call across calendar days — auto-rebalancing buckets', {
        tenantId,
        externalId: event.external_id,
        oldDate: oldCallDate,
        newDate: callDate,
        source,
      });
      // Capture for the post-commit finance alert. We do not insert the
      // operations_alerts row here because (a) it must survive a rollback of
      // the ingest txn — finance still needs to know if the upsert later
      // succeeded — and (b) it should not fail the ingest if the alert
      // insert errors. The actual insert happens after COMMIT below.
      crossDayShift = {
        externalId: event.external_id,
        oldDate: oldCallDate as string,
        newDate: callDate,
        callSessionId: callSessionId,
        source,
        // Optimistically marked as rebalanced. Flipped to 'skipped' below
        // if the OLD-day rollup row pre-check finds any missing row.
        kind: 'rebalanced',
      };
    }

    let callsDelta: number;
    let totalCostDelta: number;
    let minutesDelta: number;
    let openaiDelta: number;
    if (!isCorrection) {
      callsDelta = 1;
      totalCostDelta = event.costs.total_cents;
      minutesDelta = newAiMinutes;
      openaiDelta = event.costs.openai_cents;
    } else if (isCrossDayShift) {
      // The OLD day is debited separately below; the NEW day must receive
      // the FULL new amount (not the same-day delta) because none of this
      // event's contribution has landed on the NEW day yet.
      callsDelta = 1;
      totalCostDelta = event.costs.total_cents;
      minutesDelta = newAiMinutes;
      openaiDelta = event.costs.openai_cents;
    } else {
      callsDelta = 0;
      totalCostDelta = event.costs.total_cents - Number(existingCall.total_cost_cents);
      minutesDelta = newAiMinutes - oldAiMinutes;
      openaiDelta = event.costs.openai_cents - existingOpenaiCents;
    }

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

    if (isCrossDayShift && existingCall && oldCallDate && crossDayShift) {
      // OLD-day reversal — fully back out the original call's contribution
      // from the day it used to be attributed to.
      //
      // SAFETY GUARD: in normal operation the OLD-day rollup rows always
      // exist because the original ingest wrote them, so an
      // INSERT...ON CONFLICT...DO UPDATE with negative deltas safely lands
      // on the UPDATE branch and the math works out. But if the row is
      // missing (e.g. a tenant had a call_session row that pre-dated the
      // rollup tables, or a row was deleted out of band) the INSERT branch
      // would fire and create a `daily_org_usage` / `usage_metrics` row
      // with a NEGATIVE quantity — a data-integrity smell that downstream
      // invoicing would have to special-case. So we pre-check existence
      // and skip the debit (with a finance alert) when any row is missing.
      const oldDirection = String(existingCall.direction);
      const oldMetricType = oldDirection === 'inbound' ? 'calls_inbound' : 'calls_outbound';
      const oldPeriodStart = `${oldCallDate}T00:00:00Z`;
      const oldPeriodEnd = `${oldCallDate}T23:59:59Z`;
      const oldTotalCostCents = Number(existingCall.total_cost_cents);

      const { rows: existsRows } = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM usage_metrics
             WHERE tenant_id = $1 AND metric_type = $2::usage_metric_type AND period_start = $3) AS has_calls,
           EXISTS(SELECT 1 FROM usage_metrics
             WHERE tenant_id = $1 AND metric_type = 'ai_minutes'::usage_metric_type AND period_start = $3) AS has_minutes,
           EXISTS(SELECT 1 FROM daily_org_usage
             WHERE tenant_id = $1 AND date = $4) AS has_daily`,
        [tenantId, oldMetricType, oldPeriodStart, oldCallDate],
      );
      const exist = existsRows[0] as
        | { has_calls: boolean; has_minutes: boolean; has_daily: boolean }
        | undefined;
      const hasCalls = !!exist?.has_calls;
      const hasMinutes = !!exist?.has_minutes;
      const hasDaily = !!exist?.has_daily;
      const allOldRollupsPresent = hasCalls && hasMinutes && hasDaily;

      if (!allOldRollupsPresent) {
        logger.warn('Skipping OLD-day cross-day rebalance — at least one rollup row is missing', {
          tenantId,
          externalId: event.external_id,
          callSessionId,
          oldDate: oldCallDate,
          newDate: callDate,
          source,
          hasCalls,
          hasMinutes,
          hasDaily,
        });
        crossDayShift = {
          ...crossDayShift,
          kind: 'skipped',
          missingRollups: {
            calls: !hasCalls,
            minutes: !hasMinutes,
            daily: !hasDaily,
          },
        };
      } else {
        // Happy path. The rows exist, so we apply the negative deltas with
        // plain UPDATE statements (no INSERT fallback). This is belt-and-
        // braces over the pre-check above: the pre-check already decided
        // "all rows present, proceed", but in the narrow TOCTOU race where
        // a row got deleted between the check and the debit, the UPDATE
        // simply affects 0 rows — a NEGATIVE-quantity row can never be
        // created the way an INSERT…ON CONFLICT fallback would have.
        await client.query(
          `UPDATE usage_metrics SET
             quantity = quantity + $4,
             total_cost_cents = total_cost_cents + $5,
             updated_at = NOW()
           WHERE tenant_id = $1
             AND metric_type = $2::usage_metric_type
             AND period_start = $3`,
          [tenantId, oldMetricType, oldPeriodStart, -1, -oldTotalCostCents],
        );

        await client.query(
          `UPDATE usage_metrics SET
             quantity = quantity + $3,
             total_cost_cents = total_cost_cents + $4,
             updated_at = NOW()
           WHERE tenant_id = $1
             AND metric_type = 'ai_minutes'::usage_metric_type
             AND period_start = $2`,
          [tenantId, oldPeriodStart, -oldAiMinutes, -existingOpenaiCents],
        );

        await client.query(
          `UPDATE daily_org_usage SET
             total_calls = total_calls + $3,
             total_ai_minutes = total_ai_minutes + $4,
             total_cost_cents = total_cost_cents + $5
           WHERE tenant_id = $1 AND date = $2`,
          [tenantId, oldCallDate, -1, -oldAiMinutes, -oldTotalCostCents],
        );
      }
    }

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

    if (crossDayShift) {
      await recordBackfillCrossDayAlert(tenantId, crossDayShift);
    }

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

/**
 * Batch helper for the admin console: processes a single already-validated
 * backfill event end-to-end and returns a coarse outcome that maps cleanly
 * to a per-row result in the batch response.
 */
async function processOneBackfillEvent(
  tenantId: string,
  event: CallBackfillEventV1,
): Promise<
  | { outcome: 'inserted' }
  | { outcome: 'duplicate' }
  | { outcome: 'failed'; error: string }
> {
  const recorded = await recordReceivedEvent(tenantId, event, 'remix-backfill');
  if (!recorded.ok) {
    return { outcome: 'failed', error: recorded.error };
  }
  if (recorded.duplicate) {
    return { outcome: 'duplicate' };
  }
  const result = await persistCallEvent(tenantId, event, 'remix-backfill');
  if (result.status === 201) {
    return { outcome: 'inserted' };
  }
  const errMsg =
    typeof (result.body as { error?: unknown }).error === 'string'
      ? ((result.body as { error: string }).error)
      : 'persist failed';
  return { outcome: 'failed', error: errMsg };
}

const BackfillBatchAttestationSchema = z.object({
  reason: z.string().min(8).max(500),
  attested_by: z.string().min(1).max(120),
  original_system: z.string().min(1).max(120).optional(),
  attested_at: z.string().datetime().optional(),
});

/**
 * Batch backfill schema. Each `rows[i]` is a partial call event. The tool
 * fills in `tenant_id`, `version`, `event_type`, `backfill_attestation`, and
 * a default `timestamp` so the operator only has to supply the per-call
 * payload itself.
 */
const BackfillBatchRequestSchema = z.object({
  tenant_id: z.string().min(1).optional(),
  attestation: BackfillBatchAttestationSchema,
  rows: z.array(z.record(z.unknown())).min(1).max(500),
  concurrency: z.number().int().min(1).max(8).optional(),
});

const BACKFILL_BATCH_MAX_ROWS = 500;
const BACKFILL_BATCH_DEFAULT_CONCURRENCY = 4;

interface BackfillBatchRowResult {
  row_index: number;
  idempotency_key: string | null;
  external_id: string | null;
  status: 'inserted' | 'duplicate' | 'window_rejected' | 'validation_failed' | 'failed';
  age_days?: number;
  error?: string;
}

/**
 * Admin-console batch helper for the federated call backfill endpoint.
 * Accepts an array of row payloads + a single attestation block + optional
 * `tenant_id`, then fans out to the same per-event pipeline used by the
 * single-event `/v1/ingest/calls/backfill` endpoint with bounded concurrency.
 *
 * Authorisation:
 *  - JWT only (admin console tool, never used with API keys).
 *  - Platform admins may target any tenant via `tenant_id`.
 *  - Tenant operators (tenant_owner / operations_manager) may only replay
 *    calls for their own tenant; `tenant_id`, when provided, must match.
 *
 * Idempotency keys come from the rows verbatim, so re-running the same CSV
 * after a partial failure yields `duplicate` for already-processed rows
 * and inserts the rest, making the tool safely resumable.
 */
router.post(
  '/v1/ingest/calls/backfill/batch',
  requireAuth,
  async (req: Request, res: Response) => {
    req.skipAuditMutation = true;

    const userTenantId = req.user!.tenantId;
    const isPlatformAdmin = req.user!.isPlatformAdmin;
    const role = req.user!.role;

    if (!isPlatformAdmin && role !== 'tenant_owner' && role !== 'operations_manager') {
      return res.status(403).json({
        error: 'Owner, operations manager, or platform admin role required',
      });
    }

    const parsed = BackfillBatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }
    const { rows, attestation } = parsed.data;
    const targetTenant = parsed.data.tenant_id ?? userTenantId;
    if (targetTenant !== userTenantId && !isPlatformAdmin) {
      return res.status(403).json({
        error: 'Cannot replay calls for another tenant',
      });
    }
    if (rows.length > BACKFILL_BATCH_MAX_ROWS) {
      return res.status(400).json({
        error: `Batch size exceeds maximum of ${BACKFILL_BATCH_MAX_ROWS} rows`,
      });
    }

    const concurrency = parsed.data.concurrency ?? BACKFILL_BATCH_DEFAULT_CONCURRENCY;

    const results: BackfillBatchRowResult[] = new Array(rows.length);
    const summary = {
      total: rows.length,
      inserted: 0,
      duplicate: 0,
      window_rejected: 0,
      validation_failed: 0,
      failed: 0,
    };

    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= rows.length) return;

        const raw = rows[i] as Record<string, unknown>;
        const rawIdem = typeof raw.idempotency_key === 'string' ? raw.idempotency_key : null;
        const rawExt = typeof raw.external_id === 'string' ? raw.external_id : null;

        const candidate: Record<string, unknown> = {
          version: 'v1',
          event_type: 'call.completed',
          timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
          ...raw,
          tenant_id: targetTenant,
          backfill_attestation: attestation,
        };

        const validated = CallBackfillEventV1Schema.safeParse(candidate);
        if (!validated.success) {
          summary.validation_failed += 1;
          results[i] = {
            row_index: i,
            idempotency_key: rawIdem,
            external_id: rawExt,
            status: 'validation_failed',
            error: JSON.stringify(validated.error.flatten().fieldErrors),
          };
          continue;
        }

        const event = validated.data;
        const age = ageInDays(event.start_time);
        const ageRounded = Math.round(age * 100) / 100;

        if (age > INGEST_BACKFILL_WINDOW_DAYS) {
          summary.window_rejected += 1;
          results[i] = {
            row_index: i,
            idempotency_key: event.idempotency_key,
            external_id: event.external_id,
            status: 'window_rejected',
            age_days: ageRounded,
            error: `Older than backfill window (${INGEST_BACKFILL_WINDOW_DAYS} days)`,
          };
          continue;
        }
        if (age <= INGEST_FRESH_WINDOW_DAYS) {
          summary.window_rejected += 1;
          results[i] = {
            row_index: i,
            idempotency_key: event.idempotency_key,
            external_id: event.external_id,
            status: 'window_rejected',
            age_days: ageRounded,
            error: 'Inside live window — use /v1/ingest/calls instead',
          };
          continue;
        }
        if (age < -1) {
          summary.window_rejected += 1;
          results[i] = {
            row_index: i,
            idempotency_key: event.idempotency_key,
            external_id: event.external_id,
            status: 'window_rejected',
            age_days: ageRounded,
            error: 'Event start_time is in the future',
          };
          continue;
        }

        const outcome = await processOneBackfillEvent(targetTenant, event);
        if (outcome.outcome === 'inserted') {
          summary.inserted += 1;
          results[i] = {
            row_index: i,
            idempotency_key: event.idempotency_key,
            external_id: event.external_id,
            status: 'inserted',
            age_days: ageRounded,
          };
        } else if (outcome.outcome === 'duplicate') {
          summary.duplicate += 1;
          results[i] = {
            row_index: i,
            idempotency_key: event.idempotency_key,
            external_id: event.external_id,
            status: 'duplicate',
            age_days: ageRounded,
          };
        } else {
          summary.failed += 1;
          results[i] = {
            row_index: i,
            idempotency_key: event.idempotency_key,
            external_id: event.external_id,
            status: 'failed',
            age_days: ageRounded,
            error: outcome.error,
          };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()),
    );

    logger.info('Call backfill batch completed', {
      tenantId: targetTenant,
      requestedBy: req.user!.userId,
      summary,
    });

    return res.status(200).json({
      tenant_id: targetTenant,
      summary,
      results,
    });
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

/**
 * Read-only helper for the admin "Backfill calls" console (BL-041 follow-up).
 *
 * Given a list of `external_id`s, returns which of them already have a
 * `call_sessions` row for the authenticated tenant. The frontend uses this to
 * preview how many events in a paste/CSV would be NEW INSERTS vs CORRECTIONS
 * before the operator clicks Submit. Tenant-scoped (RLS via
 * `withTenantContext`), idempotent, and capped at 1000 ids per call so a
 * runaway paste cannot stall the pool.
 */
const PreviewExistingSchema = z.object({
  external_ids: z.array(z.string().min(1).max(255)).min(1).max(1000),
});

router.post(
  '/v1/ingest/calls/preview-existing',
  apiKeyAuth,
  ingestLimiter,
  requireApiKeyPermission('read-only'),
  async (req: Request, res: Response) => {
    req.skipAuditMutation = true;
    const tenantId = req.user!.tenantId;

    const parsed = PreviewExistingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const ids = Array.from(new Set(parsed.data.external_ids));

    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const { rows } = await client.query(
        `SELECT external_id FROM call_sessions
          WHERE tenant_id = $1 AND external_id = ANY($2::text[])`,
        [tenantId, ids],
      );
      await client.query('COMMIT');

      const existing = rows.map((r) => r.external_id as string);
      return res.json({
        tenant_id: tenantId,
        checked: ids.length,
        existing,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Preview-existing lookup failed', { tenantId, error: String(err) });
      return res.status(500).json({ error: 'Failed to look up existing call sessions' });
    } finally {
      client.release();
    }
  },
);

export default router;
