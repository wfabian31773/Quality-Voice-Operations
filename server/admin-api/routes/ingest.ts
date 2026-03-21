import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireApiKeyOrJwt } from '../middleware/apiKeyAuth';
import { requireApiKeyPermission } from '../middleware/apiKeyScope';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import {
  CallCompletionEventV1Schema,
  TicketCreationEventV1Schema,
} from '../../../shared/ingest/eventTypes';
import type { CallCompletionEventV1, TicketCreationEventV1 } from '../../../shared/ingest/eventTypes';

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

router.post(
  '/api/v1/ingest/calls',
  apiKeyAuth,
  ingestLimiter,
  requireApiKeyPermission('write'),
  async (req: Request, res: Response) => {
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

    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const insertResult = await tryRecordIngestEvent(
        client as Parameters<typeof tryRecordIngestEvent>[0],
        tenantId,
        event.idempotency_key,
        event.event_type,
        event.version,
        'remix',
        event,
        'received',
      );
      if (insertResult === 'duplicate') {
        await client.query('COMMIT');
        return res.status(409).json({ error: 'Duplicate event', idempotency_key: event.idempotency_key });
      }

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
        source: 'remix',
        status: event.status,
      });

      const { rows: existingRows } = await client.query(
        `SELECT id FROM call_sessions WHERE tenant_id = $1 AND external_id = $2`,
        [tenantId, event.external_id],
      );

      let sessionRows: { id: unknown }[];
      if (existingRows.length > 0) {
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
        await client.query(
          `INSERT INTO call_quality_scores (tenant_id, call_session_id, score, feedback, scored_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            tenantId,
            callSessionId,
            event.quality.score,
            JSON.stringify({
              sentiment: event.quality.sentiment ?? null,
              agent_outcome: event.quality.agent_outcome ?? null,
              analysis: event.quality.analysis ?? null,
              source: 'remix',
            }),
            'remix-grading',
          ],
        );
      }

      const aiMinutes = Math.ceil(event.duration_seconds / 60);
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
          event.tokens?.input_audio ?? 0 + (event.tokens?.input_text ?? 0),
          event.tokens?.output_audio ?? 0 + (event.tokens?.output_text ?? 0),
        ],
      );

      const callDate = event.start_time.slice(0, 10);
      const metricType = event.direction === 'inbound' ? 'calls_inbound' : 'calls_outbound';
      const periodStart = `${callDate}T00:00:00Z`;
      const periodEnd = `${callDate}T23:59:59Z`;

      await client.query(
        `INSERT INTO usage_metrics (tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
         VALUES ($1, $2::usage_metric_type, $3, $4, 1, $5, $5)
         ON CONFLICT (tenant_id, metric_type, period_start) DO UPDATE SET
           quantity = usage_metrics.quantity + 1,
           total_cost_cents = usage_metrics.total_cost_cents + $5,
           updated_at = NOW()`,
        [tenantId, metricType, periodStart, periodEnd, event.costs.total_cents],
      );

      await client.query(
        `INSERT INTO usage_metrics (tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
         VALUES ($1, 'ai_minutes'::usage_metric_type, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, metric_type, period_start) DO UPDATE SET
           quantity = usage_metrics.quantity + $4,
           total_cost_cents = usage_metrics.total_cost_cents + $6,
           updated_at = NOW()`,
        [tenantId, periodStart, periodEnd, aiMinutes, event.costs.openai_cents, event.costs.openai_cents],
      );

      await client.query(
        `INSERT INTO daily_org_usage (tenant_id, date, total_calls, total_ai_minutes, total_cost_cents)
         VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (tenant_id, date) DO UPDATE SET
           total_calls = daily_org_usage.total_calls + 1,
           total_ai_minutes = daily_org_usage.total_ai_minutes + $3,
           total_cost_cents = daily_org_usage.total_cost_cents + $4`,
        [tenantId, callDate, aiMinutes, event.costs.total_cents],
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
      });

      return res.status(201).json({
        status: 'processed',
        call_session_id: callSessionId,
        idempotency_key: event.idempotency_key,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Call ingest failed', { tenantId, error: String(err) });

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

      return res.status(500).json({ error: 'Failed to process call event' });
    } finally {
      client.release();
    }
  },
);

router.post(
  '/api/v1/ingest/tickets',
  apiKeyAuth,
  ingestLimiter,
  requireApiKeyPermission('write'),
  async (req: Request, res: Response) => {
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
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const insertResult = await tryRecordIngestEvent(
        client as Parameters<typeof tryRecordIngestEvent>[0],
        tenantId,
        event.idempotency_key,
        event.event_type,
        event.version,
        'remix',
        event,
        'received',
      );
      if (insertResult === 'duplicate') {
        await client.query('COMMIT');
        return res.status(409).json({ error: 'Duplicate event', idempotency_key: event.idempotency_key });
      }

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
        callId,
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
  '/api/v1/ingest/status',
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
