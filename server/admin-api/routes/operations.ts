import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { requireAuth } from '../middleware/auth';

const logger = createLogger('OPERATIONS_API');
const router = Router();

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

  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT id, type, severity, message, metadata, call_session_id, agent_id,
              acknowledged, acknowledged_at, created_at
       FROM operations_alerts
       WHERE tenant_id = $1 AND acknowledged = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [tenantId, acknowledged, limit],
    );

    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM operations_alerts WHERE tenant_id = $1 AND acknowledged = false`,
      [tenantId],
    );

    res.json({ alerts: rows, unacknowledgedCount: count });
  } catch (err) {
    logger.error('Failed to fetch alerts', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to fetch alerts' });
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

router.get('/operations/calls/:callId/live', requireAuth, async (req, res) => {
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(':\n\n');

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
  const heartbeat = setInterval(() => {
    if (alive) res.write(':\n\n');
  }, 15000);

  req.on('close', () => {
    alive = false;
    clearInterval(interval);
    clearInterval(heartbeat);
  });
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

export default router;
