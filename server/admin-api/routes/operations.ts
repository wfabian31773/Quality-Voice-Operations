import { Router } from 'express';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { redactPHI } from '../../../platform/core/phi/redact';
import { requireAuth } from '../middleware/auth';
import { requireOpsRole } from '../middleware/rbac';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import {
  getTenantSseConnectionLimiter,
  attachSseHeartbeat,
  resolveLiveStreamCap,
  registerSseConnection,
  ackSseConnection,
} from '../../../platform/infra/rate-limit/sseConnectionLimiter';

const logger = createLogger('OPERATIONS_API');
const router = Router();

const TENANT_LIVE_STREAM_CAP = resolveLiveStreamCap(process.env.TENANT_LIVE_STREAM_CAP);

export const operationsCallLiveRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: TENANT_LIVE_STREAM_CAP,
  keyGenerator: (req: Request) =>
    (req as Request & { user?: { tenantId?: string } }).user?.tenantId ?? 'platform',
  message: 'Too many live-stream connection attempts for this tenant.',
});

router.get('/operations/realtime', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const range = String(req.query.range ?? '1h');

  let intervalSql: string;
  switch (range) {
    case '1h': intervalSql = "INTERVAL '1 hour'"; break;
    case 'today': intervalSql = "(NOW() - DATE_TRUNC('day', NOW()))"; break;
    case '7d': intervalSql = "INTERVAL '7 days'"; break;
    case '30d': intervalSql = "INTERVAL '30 days'"; break;
    default: intervalSql = "INTERVAL '1 hour'";
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const metricsQuery = `
      SELECT
        COUNT(*)::int AS total_calls,
        COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed_calls,
        COUNT(*) FILTER (WHERE lifecycle_state IN ('CALL_FAILED','WORKFLOW_FAILED','ESCALATION_FAILED'))::int AS failed_calls,
        COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated_calls,
        COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration,
        COUNT(*) FILTER (WHERE lifecycle_state NOT IN ('CALL_COMPLETED','CALL_FAILED','WORKFLOW_FAILED','ESCALATION_FAILED'))::int AS active_calls
      FROM call_sessions
      WHERE tenant_id = $1 AND start_time > NOW() - ${intervalSql}
    `;

    const { rows: [metrics] } = await client.query(metricsQuery, [tenantId]);

    const hourlyQuery = `
      SELECT
        DATE_TRUNC('hour', start_time) AS hour,
        COUNT(*)::int AS calls
      FROM call_sessions
      WHERE tenant_id = $1 AND start_time > NOW() - ${intervalSql}
      GROUP BY DATE_TRUNC('hour', start_time)
      ORDER BY hour ASC
    `;
    const { rows: hourlyData } = await client.query(hourlyQuery, [tenantId]);

    const toolsQuery = `
      SELECT
        COUNT(*)::int AS total_executions,
        COUNT(*) FILTER (WHERE event_type = 'TOOL_END')::int AS completed_tools,
        COUNT(*) FILTER (WHERE event_type = 'TOOL_START')::int AS started_tools
      FROM call_events
      WHERE tenant_id = $1
        AND event_type IN ('TOOL_START', 'TOOL_END')
        AND occurred_at > NOW() - ${intervalSql}
    `;
    const { rows: [toolMetrics] } = await client.query(toolsQuery, [tenantId]);

    const recentToolsQuery = `
      SELECT ce.id, ce.event_type, ce.payload, ce.occurred_at,
             cs.agent_id, a.name AS agent_name,
             cs.caller_number
      FROM call_events ce
      JOIN call_sessions cs ON cs.id = ce.call_session_id AND cs.tenant_id = ce.tenant_id
      LEFT JOIN agents a ON a.id = cs.agent_id AND a.tenant_id = cs.tenant_id
      WHERE ce.tenant_id = $1
        AND ce.event_type IN ('TOOL_START', 'TOOL_END')
        AND ce.occurred_at > NOW() - ${intervalSql}
      ORDER BY ce.occurred_at DESC
      LIMIT 50
    `;
    const { rows: recentTools } = await client.query(recentToolsQuery, [tenantId]);

    await client.query('COMMIT');

    const totalCalls = metrics.total_calls || 0;
    const completedCalls = metrics.completed_calls || 0;
    const completionRate = totalCalls > 0 ? completedCalls / totalCalls : 0;

    let hoursInRange = 1;
    if (range === '1h') hoursInRange = 1;
    else if (range === 'today') hoursInRange = Math.max(1, new Date().getHours() || 1);
    else if (range === '7d') hoursInRange = 168;
    else if (range === '30d') hoursInRange = 720;

    const callsPerHour = totalCalls > 0 ? (totalCalls / hoursInRange) : 0;

    res.json({
      totalCalls,
      completedCalls,
      failedCalls: metrics.failed_calls || 0,
      escalatedCalls: metrics.escalated_calls || 0,
      activeCalls: metrics.active_calls || 0,
      avgDuration: Math.round(metrics.avg_duration || 0),
      completionRate: Math.round(completionRate * 100),
      callsPerHour: Math.round(callsPerHour * 10) / 10,
      toolExecutions: toolMetrics.completed_tools || 0,
      toolsRunning: (toolMetrics.started_tools || 0) - (toolMetrics.completed_tools || 0),
      hourlyData: hourlyData.map((r: { hour: string; calls: number }) => ({
        hour: r.hour,
        calls: r.calls,
      })),
      recentTools: recentTools.map((r: Record<string, unknown>) => ({
        id: r.id,
        eventType: r.event_type,
        tool: (r.payload as Record<string, unknown>)?.tool ?? 'unknown',
        agentName: r.agent_name ?? 'Unknown',
        callerNumber: redactPhone(r.caller_number as string | null),
        timestamp: r.occurred_at,
        status: (r.event_type as string) === 'TOOL_END' ? 'completed' : 'running',
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to fetch realtime metrics', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to fetch realtime metrics' });
  } finally {
    client.release();
  }
});

router.get('/operations/alerts', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const acknowledged = req.query.acknowledged === 'true';
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
  // Optional alert-type filter. Used by surfaces that only care about a single
  // alert kind (e.g. the dashboard "billing needs attention" banner) so the
  // returned `unacknowledgedCount` is exact for that type instead of being
  // capped by the listing `limit`.
  const typeFilter =
    typeof req.query.type === 'string' && req.query.type.trim().length > 0
      ? req.query.type.trim()
      : null;

  const pool = getPlatformPool();
  try {
    const listParams: Array<string | boolean | number> = [tenantId, acknowledged];
    let typeSql = '';
    if (typeFilter) {
      listParams.push(typeFilter);
      typeSql = ` AND type = $${listParams.length}`;
    }
    listParams.push(limit);
    const limitParam = `$${listParams.length}`;

    const { rows } = await pool.query(
      `SELECT id, type, severity, message, metadata, call_session_id, agent_id,
              acknowledged, acknowledged_at, created_at
       FROM operations_alerts
       WHERE tenant_id = $1 AND acknowledged = $2${typeSql}
       ORDER BY created_at DESC
       LIMIT ${limitParam}`,
      listParams,
    );

    // The unack count must match the same type scope as the listing so the
    // banner / badge can trust it as a true total (not capped by `limit`).
    const countParams: Array<string> = [tenantId];
    let countTypeSql = '';
    if (typeFilter) {
      countParams.push(typeFilter);
      countTypeSql = ` AND type = $${countParams.length}`;
    }
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM operations_alerts
        WHERE tenant_id = $1 AND acknowledged = false${countTypeSql}`,
      countParams,
    );

    res.json({ alerts: rows, unacknowledgedCount: count });
  } catch (err) {
    logger.error('Failed to fetch alerts', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Cap to prevent an unbounded `types=` from blowing up the IN-clause.
const ALERT_SUMMARY_MAX_TYPES = 32;

router.get('/operations/alerts/summary', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  const rawTypes = typeof req.query.types === 'string' ? req.query.types : '';
  const requestedTypes = rawTypes
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, ALERT_SUMMARY_MAX_TYPES);

  const pool = getPlatformPool();
  try {
    const params: Array<string> = [tenantId];
    let typeSql = '';
    if (requestedTypes.length > 0) {
      const placeholders = requestedTypes
        .map((_, i) => `$${params.length + i + 1}`)
        .join(', ');
      params.push(...requestedTypes);
      typeSql = ` AND type IN (${placeholders})`;
    }

    const { rows } = await pool.query(
      `SELECT type, COUNT(*)::int AS count
         FROM operations_alerts
        WHERE tenant_id = $1 AND acknowledged = false${typeSql}
        GROUP BY type`,
      params,
    );

    const counts: Record<string, number> = {};
    for (const r of rows as Array<{ type: string; count: number }>) {
      if (r.count > 0) counts[r.type] = r.count;
    }

    res.json({ counts });
  } catch (err) {
    logger.error('Failed to fetch alert summary', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to fetch alert summary' });
  }
});

router.post('/operations/alerts/:alertId/acknowledge', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { alertId } = req.params;

  const pool = getPlatformPool();
  try {
    const result = await pool.query(
      `UPDATE operations_alerts
       SET acknowledged = true, acknowledged_at = NOW(), acknowledged_by = $3
       WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      [alertId, tenantId, userId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to acknowledge alert', { tenantId, alertId, error: String(err) });
    return res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

router.post('/operations/alerts/acknowledge-all', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;

  const pool = getPlatformPool();
  try {
    const result = await pool.query(
      `UPDATE operations_alerts
       SET acknowledged = true, acknowledged_at = NOW(), acknowledged_by = $2
       WHERE tenant_id = $1 AND acknowledged = false`,
      [tenantId, userId],
    );

    res.json({ acknowledged: result.rowCount });
  } catch (err) {
    logger.error('Failed to acknowledge all alerts', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to acknowledge alerts' });
  }
});

router.get('/operations/calls/:callId/live', requireAuth, operationsCallLiveRateLimiter, async (req, res) => {
  const { tenantId } = req.user!;
  const { callId } = req.params;

  const pool = getPlatformPool();

  try {
    const { rows: sessionCheck } = await pool.query(
      `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [callId, tenantId],
    );

    if (sessionCheck.length === 0) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }
  } catch (err) {
    logger.error('Failed to validate call session', { callId, error: String(err) });
    res.status(500).json({ error: 'Internal error' });
    return;
  }

  if (!getTenantSseConnectionLimiter().acquire(req, res)) {
    logger.warn('Rejected ops live-stream connection — tenant cap reached', {
      tenantId,
      callId,
      cap: TENANT_LIVE_STREAM_CAP,
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const connectionId = randomUUID();
  res.write(`event: connection\ndata: ${JSON.stringify({ connectionId })}\n\n`);

  let alive = true;
  const seenEventIds = new Set<string>();
  let lastState: string | null = null;
  let lastTranscriptLength = 0;
  let trailingPartialLine = '';

  const poll = async () => {
    if (!alive) return;

    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.lifecycle_state, cs.caller_number, cs.agent_id,
                a.name AS agent_name, cs.start_time, cs.end_time,
                cs.duration_seconds, cs.context
         FROM call_sessions cs
         LEFT JOIN agents a ON a.id = cs.agent_id AND a.tenant_id = cs.tenant_id
         WHERE cs.id = $1 AND cs.tenant_id = $2`,
        [callId, tenantId],
      );

      if (sessionRows.length === 0) return;
      const session = sessionRows[0];

      if (session.lifecycle_state !== lastState) {
        lastState = session.lifecycle_state;
        res.write(`event: call_state\ndata: ${JSON.stringify({
          callId: session.id,
          state: session.lifecycle_state,
          agentName: session.agent_name,
          startTime: session.start_time,
          endTime: session.end_time,
          durationSeconds: session.duration_seconds,
        })}\n\n`);
      }

      const transcript = session.context?.transcript as string | undefined;
      if (transcript && transcript.length > lastTranscriptLength) {
        const newContent = transcript.substring(lastTranscriptLength);
        lastTranscriptLength = transcript.length;

        const combined = trailingPartialLine + newContent;
        const parts = combined.split('\n');
        trailingPartialLine = combined.endsWith('\n') ? '' : (parts.pop() ?? '');

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const callerMatch = trimmed.match(/^CALLER:\s*(.+)/i);
          const agentMatch = trimmed.match(/^AGENT:\s*(.+)/i);

          if (callerMatch) {
            res.write(`event: transcript\ndata: ${JSON.stringify({
              speaker: 'caller',
              text: callerMatch[1],
              timestamp: new Date().toISOString(),
            })}\n\n`);
          } else if (agentMatch) {
            res.write(`event: transcript\ndata: ${JSON.stringify({
              speaker: 'agent',
              text: agentMatch[1],
              timestamp: new Date().toISOString(),
            })}\n\n`);
          }
        }
      }

      const { rows: eventRows } = await pool.query(
        `SELECT id, event_type, payload, occurred_at, from_state, to_state
         FROM call_events
         WHERE call_session_id = $1 AND tenant_id = $2
         ORDER BY occurred_at ASC, id ASC
         LIMIT 200`,
        [callId, tenantId],
      );

      for (const event of eventRows) {
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);

        const eventType = event.event_type.toLowerCase();

        if (eventType === 'tool_start') {
          res.write(`event: tool_start\ndata: ${JSON.stringify({
            invocationId: event.id,
            tool: (event.payload as Record<string, unknown>)?.tool ?? 'unknown',
            timestamp: event.occurred_at,
          })}\n\n`);
        } else if (eventType === 'tool_end') {
          const toolPayload = event.payload as Record<string, unknown> | null;
          const pairedStartId = findPairedToolStart(eventRows, event, seenEventIds);
          res.write(`event: tool_end\ndata: ${JSON.stringify({
            invocationId: event.id,
            tool: toolPayload?.tool ?? 'unknown',
            pairedStartId,
            timestamp: event.occurred_at,
          })}\n\n`);
        }

        res.write(`event: activity\ndata: ${JSON.stringify({
          id: event.id,
          eventType: event.event_type,
          fromState: event.from_state,
          toState: event.to_state,
          payload: event.payload,
          timestamp: event.occurred_at,
        })}\n\n`);
      }
    } catch (err) {
      logger.error('Operations SSE poll failed', { callId, error: String(err) });
    }
  };

  await poll();
  const interval = setInterval(poll, 2000);
  const detachHeartbeat = attachSseHeartbeat(req, res, {
    intervalMs: 15_000,
    idleTimeoutMs: 60_000,
  });
  const unregister = registerSseConnection(
    tenantId,
    connectionId,
    detachHeartbeat.ack,
    { callId },
  );

  req.on('close', () => {
    alive = false;
    clearInterval(interval);
    unregister();
    detachHeartbeat();
  });
});

router.post('/operations/calls/:callId/live/ack', requireAuth, (req, res) => {
  const { tenantId } = req.user!;
  const { callId } = req.params;
  const connectionId =
    (req.body && typeof req.body === 'object' && (req.body as { connectionId?: unknown }).connectionId) ||
    req.query.connectionId;
  if (typeof connectionId !== 'string' || !connectionId) {
    return res.status(400).json({ error: 'connectionId required' });
  }
  // Require the registered connection to be scoped to this :callId so an
  // ack request to /operations/calls/A/live/ack cannot refresh a stream
  // that was opened against /operations/calls/B/live, even if the caller
  // somehow obtained the other stream's connectionId.
  const ok = ackSseConnection(tenantId, connectionId, { callId });
  if (!ok) return res.status(404).json({ error: 'unknown connectionId' });
  return res.status(204).end();
});

function findPairedToolStart(
  allEvents: Array<{ id: string; event_type: string; payload: unknown; occurred_at: string }>,
  toolEndEvent: { payload: unknown; occurred_at: string },
  _seenIds: Set<string>,
): string | null {
  const toolName = (toolEndEvent.payload as Record<string, unknown> | null)?.tool;
  if (!toolName) return null;
  for (let i = allEvents.length - 1; i >= 0; i--) {
    const e = allEvents[i];
    if (
      e.event_type.toLowerCase() === 'tool_start' &&
      (e.payload as Record<string, unknown> | null)?.tool === toolName &&
      new Date(e.occurred_at) <= new Date(toolEndEvent.occurred_at)
    ) {
      return e.id;
    }
  }
  return null;
}

function redactPhone(phone: string | null): string {
  if (!phone) return '***';
  if (phone.length <= 4) return '***';
  return '***' + phone.slice(-4);
}

// Field-name patterns that indicate the value is sensitive identity data and
// should be redacted whole rather than scrubbed in place. Phones, names, DOBs
// etc. inside arbitrary string fields are still caught by `redactPHI` below.
const SENSITIVE_FIELD_RE =
  /(^|_)(ssn|tax_id|email|phone|mobile|cell|first_?name|last_?name|full_?name|dob|date_?of_?birth|birth_?date|address|street|zip|postal|password|token|secret|api_?key|authorization|auth)($|_)/i;

/**
 * Walk an outbox payload (or any JSON value) and redact PII so the admin
 * console never displays raw caller PHI even when an operator is debugging
 * a wedged event. Strings are scrubbed via the platform `redactPHI` regex;
 * obviously-sensitive object fields are replaced with a tagged placeholder
 * rather than half-redacted.
 */
export function redactOutboxValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactPHI(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactOutboxValue(v));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Sensitive key → collapse the whole value (any type, including nested
    // objects like `address: { line1, zip }`) to the redacted sentinel.
    if (SENSITIVE_FIELD_RE.test(k)) {
      out[k] = v === null || v === undefined ? v : '[REDACTED]';
    } else {
      out[k] = redactOutboxValue(v);
    }
  }
  return out;
}

const OUTBOX_RETRYABLE_STATUSES = ['failed', 'dead_letter'] as const;
type OutboxRetryableStatus = (typeof OUTBOX_RETRYABLE_STATUSES)[number];
function isOutboxRetryableStatus(s: string): s is OutboxRetryableStatus {
  return (OUTBOX_RETRYABLE_STATUSES as readonly string[]).includes(s);
}

const OUTBOX_LISTABLE_STATUSES = [
  'pending',
  'processing',
  'failed',
  'dead_letter',
  'delivered',
] as const;
function isOutboxListableStatus(s: string): boolean {
  return (OUTBOX_LISTABLE_STATUSES as readonly string[]).includes(s);
}

router.get('/operations/integration-diagnostics', requireAuth, requireOpsRole, async (req, res) => {
  const { tenantId } = req.user!;
  const statusFilter = req.query.status as string | undefined;
  // The "outboxProvider" param scopes the outbox panel (counters, breakdown,
  // and listing) to a single integration provider. We keep the existing
  // "provider" param dedicated to the connector-dispatches panel so the two
  // filters can be controlled independently from the UI.
  // Whitespace-only or "all" → treat as no filter (avoids `i.provider = ''`).
  const outboxProviderRaw = req.query.outboxProvider as string | undefined;
  const outboxProviderTrimmed =
    outboxProviderRaw && outboxProviderRaw !== 'all' ? outboxProviderRaw.trim() : '';
  const outboxProvider = outboxProviderTrimmed.length > 0 ? outboxProviderTrimmed : null;
  const pool = getPlatformPool();

  try {
    const webhookParams: (string | undefined)[] = [tenantId];
    let webhookFilters = '';
    if (statusFilter && statusFilter !== 'all' && isOutboxListableStatus(statusFilter)) {
      webhookParams.push(statusFilter);
      webhookFilters += ` AND oe.status = $${webhookParams.length}`;
    }
    if (outboxProvider) {
      webhookParams.push(outboxProvider);
      webhookFilters += ` AND i.provider = $${webhookParams.length}`;
    }

    const webhookQuery = `
      SELECT oe.id, oe.event_type, oe.status, oe.attempts, oe.max_attempts,
             oe.last_error, oe.payload, oe.created_at, oe.updated_at,
             oe.delivered_at, oe.next_attempt_at,
             i.name AS integration_name,
             i.provider AS integration_provider
      FROM outbox_events oe
      LEFT JOIN integrations i ON i.id = oe.integration_id AND i.tenant_id = oe.tenant_id
      WHERE oe.tenant_id = $1
        AND oe.archived_at IS NULL
        ${webhookFilters}
      ORDER BY oe.created_at DESC LIMIT 100
    `;

    const { rows: rawWebhooks } = await pool.query(webhookQuery, webhookParams);
    const webhooks = rawWebhooks.map((w: Record<string, unknown>) => ({
      ...w,
      payload: redactOutboxValue(w.payload ?? {}),
      last_error: typeof w.last_error === 'string' ? redactPHI(w.last_error) : w.last_error,
    }));

    // Aggregate counters across the active (non-archived) outbox so ops can
    // see at a glance whether the queue is wedged. `delivered` is scoped to
    // the last 24h because the lifetime delivered count grows unbounded and
    // isn't actionable.
    const summaryParams: (string | undefined)[] = [tenantId];
    let summaryProviderSql = '';
    if (outboxProvider) {
      summaryParams.push(outboxProvider);
      summaryProviderSql = ` AND i.provider = $2`;
    }
    const { rows: summaryRows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE oe.status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE oe.status = 'processing')::int AS processing,
         COUNT(*) FILTER (WHERE oe.status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE oe.status = 'dead_letter')::int AS dead_letter,
         COUNT(*) FILTER (
           WHERE oe.status = 'delivered'
             AND oe.delivered_at IS NOT NULL
             AND oe.delivered_at > NOW() - INTERVAL '24 hours'
         )::int AS delivered_24h,
         MIN(oe.created_at) FILTER (WHERE oe.status IN ('pending','failed','processing'))
           AS oldest_unresolved_at
       FROM outbox_events oe
       LEFT JOIN integrations i ON i.id = oe.integration_id AND i.tenant_id = oe.tenant_id
       WHERE oe.tenant_id = $1 AND oe.archived_at IS NULL
       ${summaryProviderSql}`,
      summaryParams,
    );
    const summary = summaryRows[0] ?? {
      pending: 0,
      processing: 0,
      failed: 0,
      dead_letter: 0,
      delivered_24h: 0,
      oldest_unresolved_at: null,
    };

    // 24h hourly buckets for sparklines. We bucket on COALESCE(delivered_at,
    // created_at) so a 'delivered' bar lines up with when delivery actually
    // succeeded while pending/failed bars line up with when the row was
    // created. Empty hours are filled in client-side.
    const sparkParams: (string | undefined)[] = [tenantId];
    let sparkProviderSql = '';
    if (outboxProvider) {
      sparkParams.push(outboxProvider);
      sparkProviderSql = ` AND i.provider = $2`;
    }
    const { rows: sparkRows } = await pool.query(
      `SELECT
         DATE_TRUNC('hour', COALESCE(oe.delivered_at, oe.created_at)) AS bucket,
         oe.status::text AS status,
         COUNT(*)::int AS count
       FROM outbox_events oe
       LEFT JOIN integrations i ON i.id = oe.integration_id AND i.tenant_id = oe.tenant_id
       WHERE oe.tenant_id = $1
         AND oe.archived_at IS NULL
         AND COALESCE(oe.delivered_at, oe.created_at) > NOW() - INTERVAL '24 hours'
         ${sparkProviderSql}
       GROUP BY bucket, oe.status
       ORDER BY bucket ASC`,
      sparkParams,
    );
    const sparklines: Record<string, Array<{ bucket: string; count: number }>> = {
      pending: [],
      processing: [],
      failed: [],
      dead_letter: [],
      delivered: [],
    };
    for (const r of sparkRows as Array<{ bucket: string; status: string; count: number }>) {
      if (sparklines[r.status]) {
        sparklines[r.status].push({ bucket: r.bucket, count: r.count });
      }
    }

    // Per-provider breakdown of currently-stuck rows. We surface failed and
    // dead_letter side-by-side so an operator can spot "all failures are
    // HubSpot" without scanning the listing.
    const { rows: providerBreakdown } = await pool.query(
      `SELECT
         COALESCE(i.provider, 'unknown') AS provider,
         COALESCE(i.name, '(no integration)') AS integration_name,
         COUNT(*) FILTER (WHERE oe.status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE oe.status = 'dead_letter')::int AS dead_letter,
         COUNT(*) FILTER (WHERE oe.status = 'pending')::int AS pending,
         MAX(oe.updated_at) FILTER (WHERE oe.status IN ('failed','dead_letter')) AS last_failure_at
       FROM outbox_events oe
       LEFT JOIN integrations i ON i.id = oe.integration_id AND i.tenant_id = oe.tenant_id
       WHERE oe.tenant_id = $1
         AND oe.archived_at IS NULL
         AND oe.status IN ('failed','dead_letter','pending')
       GROUP BY i.provider, i.name
       HAVING COUNT(*) FILTER (WHERE oe.status IN ('failed','dead_letter','pending')) > 0
       ORDER BY dead_letter DESC, failed DESC, pending DESC`,
      [tenantId],
    );

    // Distinct providers represented in the active outbox so the UI can
    // populate the outbox provider filter dropdown.
    const { rows: outboxProviderRows } = await pool.query(
      `SELECT DISTINCT i.provider
         FROM outbox_events oe
         JOIN integrations i ON i.id = oe.integration_id AND i.tenant_id = oe.tenant_id
        WHERE oe.tenant_id = $1
          AND oe.archived_at IS NULL
          AND i.provider IS NOT NULL
        ORDER BY i.provider ASC`,
      [tenantId],
    );
    const outboxProviders = outboxProviderRows
      .map((r: Record<string, unknown>) => String(r.provider ?? ''))
      .filter((p) => p.length > 0);

    const { rows: health } = await pool.query(`
      SELECT
        i.id AS integration_id,
        i.name,
        i.provider,
        i.integration_type::text AS integration_type,
        i.is_enabled,
        COUNT(iel.id)::int AS total_events,
        COUNT(iel.id) FILTER (WHERE iel.response_status BETWEEN 200 AND 299)::int AS successful_events,
        COUNT(iel.id) FILTER (WHERE iel.response_status IS NULL OR iel.response_status < 200 OR iel.response_status >= 300)::int AS failed_events,
        COALESCE(AVG(iel.latency_ms) FILTER (WHERE iel.latency_ms IS NOT NULL), 0)::int AS avg_latency_ms,
        MAX(iel.created_at) AS last_event_at
      FROM integrations i
      LEFT JOIN integration_event_logs iel
        ON iel.service_name LIKE '%' || i.provider || '%'
        AND iel.tenant_id = i.tenant_id
        AND iel.created_at > NOW() - INTERVAL '7 days'
      WHERE i.tenant_id = $1
      GROUP BY i.id, i.name, i.provider, i.integration_type, i.is_enabled
      ORDER BY i.name ASC
    `, [tenantId]);

    const healthWithRate = health.map((h: Record<string, unknown>) => {
      const total = Number(h.total_events) || 0;
      const failed = Number(h.failed_events) || 0;
      return {
        ...h,
        error_rate: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
      };
    });

    const providerFilter = (req.query.provider as string | undefined)?.trim();

    const dispatchClient = await pool.connect();
    let connectorDispatches: unknown[] = [];
    let dispatchProviders: string[] = [];
    try {
      await dispatchClient.query('BEGIN');
      await withTenantContext(dispatchClient, tenantId, async () => {});

      const dispatchParams: (string | undefined)[] = [tenantId];
      let providerSql = '';
      if (providerFilter && providerFilter !== 'all') {
        dispatchParams.push(providerFilter);
        providerSql = ` AND split_part(iel.service_name, ':', 2) = $2`;
      }

      const { rows: dispatchRows } = await dispatchClient.query(
        `SELECT iel.id, iel.service_name, iel.request_url, iel.request_body,
                iel.response_status, iel.error_message, iel.latency_ms,
                iel.call_session_id, iel.created_at
         FROM integration_event_logs iel
         WHERE iel.tenant_id = $1
           AND iel.service_name LIKE '%:%'
           AND iel.request_url LIKE 'connector://%'
           AND iel.created_at > NOW() - INTERVAL '7 days'
           ${providerSql}
         ORDER BY iel.created_at DESC
         LIMIT 100`,
        dispatchParams,
      );

      const { rows: providerRows } = await dispatchClient.query(
        `SELECT DISTINCT split_part(iel.service_name, ':', 2) AS provider
         FROM integration_event_logs iel
         WHERE iel.tenant_id = $1
           AND iel.service_name LIKE '%:%'
           AND iel.request_url LIKE 'connector://%'
           AND iel.created_at > NOW() - INTERVAL '7 days'
         ORDER BY provider ASC`,
        [tenantId],
      );

      await dispatchClient.query('COMMIT');

      dispatchProviders = providerRows
        .map((r: Record<string, unknown>) => String(r.provider ?? ''))
        .filter((p) => p.length > 0);

      connectorDispatches = dispatchRows.map((r: Record<string, unknown>) => {
        const status = r.response_status as number | null;
        const success = status !== null && status >= 200 && status < 300;
        const body = r.request_body as Record<string, unknown> | null;
        const serviceName = String(r.service_name ?? '');
        const [connectorType, provider] = serviceName.split(':');
        return {
          id: r.id,
          eventType: (body?.type as string) ?? 'unknown',
          serviceName,
          connectorType: connectorType ?? null,
          provider: provider ?? null,
          status: success ? 'success' : 'error',
          responseStatus: status,
          errorMessage: r.error_message,
          latencyMs: r.latency_ms,
          callSessionId: r.call_session_id,
          createdAt: r.created_at,
        };
      });
    } catch (err) {
      await dispatchClient.query('ROLLBACK').catch(() => {});
      logger.warn('Failed to fetch connector dispatches', { tenantId, error: String(err) });
    } finally {
      dispatchClient.release();
    }

    const salesforceDispatches = (connectorDispatches as Array<{ provider: string | null }>).filter(
      (d) => d.provider === 'salesforce',
    );

    res.json({
      webhooks,
      health: healthWithRate,
      connectorDispatches,
      dispatchProviders,
      salesforceDispatches,
      outboxSummary: {
        pending: Number(summary.pending) || 0,
        processing: Number(summary.processing) || 0,
        failed: Number(summary.failed) || 0,
        dead_letter: Number(summary.dead_letter) || 0,
        delivered_24h: Number(summary.delivered_24h) || 0,
        oldest_unresolved_at: summary.oldest_unresolved_at ?? null,
      },
      outboxSparklines: sparklines,
      outboxProviderBreakdown: providerBreakdown.map((r: Record<string, unknown>) => ({
        provider: String(r.provider ?? 'unknown'),
        integration_name: String(r.integration_name ?? '(no integration)'),
        failed: Number(r.failed) || 0,
        dead_letter: Number(r.dead_letter) || 0,
        pending: Number(r.pending) || 0,
        last_failure_at: r.last_failure_at ?? null,
      })),
      outboxProviders,
    });
  } catch (err) {
    logger.error('Failed to fetch integration diagnostics', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to fetch integration diagnostics' });
  }
});

router.post('/operations/integration-diagnostics/:outboxId/retry', requireAuth, requireOpsRole, async (req, res) => {
  const { tenantId } = req.user!;
  const { outboxId } = req.params;
  const pool = getPlatformPool();

  try {
    const result = await pool.query(
      `UPDATE outbox_events
          SET status = 'pending',
              attempts = 0,
              last_error = NULL,
              next_attempt_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
          AND status IN ('failed', 'dead_letter')
          AND archived_at IS NULL
       RETURNING id`,
      [outboxId, tenantId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Outbox event not found or not retryable' });
    }

    logger.info('Outbox event retry queued', { tenantId, outboxId, userId: req.user!.userId });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to retry outbox event', { tenantId, outboxId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retry outbox event' });
  }
});

/**
 * Bulk-requeue every retryable outbox row that matches the supplied filters.
 * Status defaults to 'failed' (the safe everyday case); the caller can pass
 * 'dead_letter' to recover poison-pill rows that have hit max_attempts, or
 * 'all' to retry both. A provider filter scopes the action to a single
 * integration so an operator can say "retry every failed Salesforce row"
 * without touching unrelated integrations.
 *
 * The retry resets `attempts` so dead_letter rows (whose attempts already
 * equal max_attempts) become eligible for the drain claim again, mirroring
 * the per-row retry semantics in
 * `platformConnectorHealth.ts#/platform/connector-health/outbox/.../retry`.
 */
router.post(
  '/operations/integration-diagnostics/bulk-retry',
  requireAuth,
  requireOpsRole,
  async (req, res) => {
    const { tenantId, userId } = req.user!;
    const body = (req.body ?? {}) as { status?: unknown; provider?: unknown };

    const rawStatus = typeof body.status === 'string' ? body.status.trim() : 'failed';
    let statusValues: OutboxRetryableStatus[];
    if (rawStatus === 'all') {
      statusValues = [...OUTBOX_RETRYABLE_STATUSES];
    } else if (isOutboxRetryableStatus(rawStatus)) {
      statusValues = [rawStatus];
    } else {
      return res.status(400).json({
        error: `Invalid status filter "${rawStatus}". Use one of: failed, dead_letter, all.`,
      });
    }

    const provider =
      typeof body.provider === 'string' && body.provider.trim().length > 0
        ? body.provider.trim()
        : null;

    const pool = getPlatformPool();
    try {
      const params: Array<string | string[]> = [tenantId, statusValues];
      let providerSql = '';
      if (provider) {
        params.push(provider);
        providerSql = ` AND oe.integration_id IN (
          SELECT id FROM integrations WHERE tenant_id = $1 AND provider = $3
        )`;
      }

      const result = await pool.query(
        `UPDATE outbox_events oe
            SET status = 'pending',
                attempts = 0,
                last_error = NULL,
                next_attempt_at = NOW(),
                updated_at = NOW()
          WHERE oe.tenant_id = $1
            AND oe.status = ANY($2::outbox_event_status[])
            AND oe.archived_at IS NULL
            ${providerSql}
          RETURNING oe.id`,
        params,
      );

      const requeued = result.rowCount ?? 0;
      logger.info('Bulk outbox retry queued', {
        tenantId,
        userId,
        requeued,
        statusFilter: statusValues,
        provider,
      });
      return res.json({ success: true, requeued });
    } catch (err) {
      logger.error('Failed bulk outbox retry', {
        tenantId,
        error: String(err),
        statusFilter: statusValues,
        provider,
      });
      return res.status(500).json({ error: 'Failed to bulk-retry outbox events' });
    }
  },
);

export default router;
