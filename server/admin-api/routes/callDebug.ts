import { Router } from 'express';
import type { RequestHandler } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { redactPHI } from '../../../platform/core/phi/redact';
import { getCallTraces, getIntegrationEvents, maskPIIPublic } from '../../../platform/core/observability/traceLogger';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('CALL_DEBUG');
const router = Router();

router.get('/calls/:id/traces', requireAuth, (async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const traces = await getCallTraces(tenantId, id);
    return res.json({ callId: id, traces });
  } catch (err) {
    logger.error('Failed to get traces', { tenantId, callId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve traces' });
  }
}) as RequestHandler);

router.get('/calls/:id/integration-events', requireAuth, (async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const events = await getIntegrationEvents(tenantId, id);
    return res.json({ callId: id, integrationEvents: events });
  } catch (err) {
    logger.error('Failed to get integration events', { tenantId, callId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve integration events' });
  }
}) as RequestHandler);

router.get('/calls/:id/replay', requireAuth, (async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: callRows } = await client.query(
      `SELECT cs.*, a.name AS agent_name, a.slug AS agent_slug
       FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id
       WHERE cs.id = $1 AND cs.tenant_id = $2`,
      [id, tenantId],
    );

    if (callRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Call not found' });
    }

    const call = callRows[0] as Record<string, unknown>;
    if (call.caller_number) call.caller_number = redactPHI(call.caller_number as string);
    if (call.called_number) call.called_number = redactPHI(call.called_number as string);

    const { rows: transcript } = await client.query(
      `SELECT id, role, content, sequence_number, occurred_at
       FROM call_transcripts
       WHERE call_session_id = $1 AND tenant_id = $2
       ORDER BY sequence_number ASC, occurred_at ASC`,
      [id, tenantId],
    );

    const { rows: events } = await client.query(
      `SELECT id, event_type, from_state, to_state, payload, occurred_at
       FROM call_events
       WHERE call_session_id = $1 AND tenant_id = $2
       ORDER BY occurred_at ASC`,
      [id, tenantId],
    );

    const { rows: toolInvocations } = await client.query(
      `SELECT id, tool_name, input, output, status, error_message,
              duration_ms, invoked_at, completed_at, result, recovery_action
       FROM tool_invocations
       WHERE call_session_id = $1 AND tenant_id = $2
       ORDER BY invoked_at ASC`,
      [id, tenantId],
    );

    await client.query('COMMIT');

    const traces = await getCallTraces(tenantId, id);
    const integrationEvents = await getIntegrationEvents(tenantId, id);

    const sanitizedToolInvocations = toolInvocations.map((ti: Record<string, unknown>) => ({
      ...ti,
      input: maskPIIPublic(ti.input),
      output: maskPIIPublic(ti.output),
      result: maskPIIPublic(ti.result),
    }));

    const sanitizedEvents = events.map((e: Record<string, unknown>) => ({
      ...e,
      payload: maskPIIPublic(e.payload),
    }));

    return res.json({
      call,
      transcript,
      events: sanitizedEvents,
      toolInvocations: sanitizedToolInvocations,
      traces,
      integrationEvents,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to get call replay', { tenantId, callId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve call replay' });
  } finally {
    client.release();
  }
}) as RequestHandler);

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

router.get('/calls-debug/search', requireAuth, (async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const {
    agent_id,
    agent_template,
    direction,
    lifecycle_state,
    since,
    until,
    has_tool_failure,
    escalated,
    sentiment_min,
    sentiment_max,
    cost_min,
    cost_max,
    search,
    sort_by,
    sort_order,
  } = req.query as Record<string, string>;

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const conditions: string[] = ['cs.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (agent_id) { values.push(agent_id); conditions.push(`cs.agent_id = $${values.length}`); }
    if (agent_template) { values.push(agent_template); conditions.push(`a.type = $${values.length}`); }
    if (direction) { values.push(direction); conditions.push(`cs.direction = $${values.length}`); }
    if (lifecycle_state) { values.push(lifecycle_state); conditions.push(`cs.lifecycle_state = $${values.length}`); }
    if (since) { values.push(since); conditions.push(`cs.start_time >= $${values.length}::timestamptz`); }
    if (until) { values.push(until); conditions.push(`cs.start_time <= $${values.length}::timestamptz`); }
    if (has_tool_failure === 'true') { conditions.push(`cs.has_tool_failure = true`); }
    if (escalated === 'true') { conditions.push(`(cs.escalated = true OR cs.escalation_target IS NOT NULL)`); }
    if (sentiment_min) { values.push(parseFloat(sentiment_min)); conditions.push(`cs.sentiment_score >= $${values.length}`); }
    if (sentiment_max) { values.push(parseFloat(sentiment_max)); conditions.push(`cs.sentiment_score <= $${values.length}`); }
    if (cost_min) { values.push(parseInt(cost_min)); conditions.push(`cs.total_cost_cents >= $${values.length}`); }
    if (cost_max) { values.push(parseInt(cost_max)); conditions.push(`cs.total_cost_cents <= $${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(cs.id::text ILIKE $${values.length} OR cs.call_sid ILIKE $${values.length} OR a.name ILIKE $${values.length})`);
    }

    const where = conditions.join(' AND ');

    const allowedSortColumns: Record<string, string> = {
      start_time: 'cs.start_time',
      duration: 'cs.duration_seconds',
      cost: 'cs.total_cost_cents',
      sentiment: 'cs.sentiment_score',
    };
    const orderCol = allowedSortColumns[sort_by ?? ''] ?? 'cs.start_time';
    const orderDir = sort_order === 'asc' ? 'ASC' : 'DESC';

    const { rows } = await client.query(
      `SELECT cs.id, cs.agent_id, cs.direction, cs.lifecycle_state,
              cs.start_time, cs.end_time, cs.duration_seconds,
              cs.total_cost_cents, cs.environment, cs.created_at,
              cs.sentiment_score, cs.has_tool_failure, cs.escalated,
              cs.escalation_reason, cs.call_sid,
              a.name AS agent_name, a.type AS agent_type
       FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id
       WHERE ${where}
       ORDER BY ${orderCol} ${orderDir} NULLS LAST
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id
       WHERE ${where}`,
      values,
    );
    await client.query('COMMIT');

    return res.json({
      calls: rows.map((r: Record<string, unknown>) => {
        if (r.caller_number) r.caller_number = redactPHI(r.caller_number as string);
        return r;
      }),
      total: parseInt(countRows[0].total as string),
      limit,
      offset,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to search calls', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to search calls' });
  } finally {
    client.release();
  }
}) as RequestHandler);

router.get('/operations/live-board', requireAuth, (async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: activeCalls } = await client.query(
      `SELECT cs.id, cs.agent_id, cs.direction, cs.lifecycle_state,
              cs.start_time, cs.caller_number, cs.called_number,
              cs.workflow_id, cs.context, cs.duration_seconds,
              a.name AS agent_name, a.slug AS agent_slug,
              EXTRACT(EPOCH FROM (NOW() - cs.start_time))::int AS elapsed_seconds
       FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id
       WHERE cs.tenant_id = $1
         AND cs.lifecycle_state NOT IN ('CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED')
       ORDER BY cs.start_time DESC`,
      [tenantId],
    );

    const callIds = activeCalls.map((c: Record<string, unknown>) => c.id);
    let activeToolCalls: Record<string, unknown>[] = [];
    if (callIds.length > 0) {
      const { rows } = await client.query(
        `SELECT ti.id, ti.call_session_id, ti.tool_name, ti.status, ti.invoked_at, ti.duration_ms
         FROM tool_invocations ti
         WHERE ti.tenant_id = $1
           AND ti.call_session_id = ANY($2)
           AND ti.status IN ('pending', 'running')
         ORDER BY ti.invoked_at DESC`,
        [tenantId, callIds],
      );
      activeToolCalls = rows;
    }

    let recentTraces: Record<string, unknown>[] = [];
    if (callIds.length > 0) {
      const { rows } = await client.query(
        `SELECT et.id, et.call_session_id, et.trace_type, et.step_name,
                et.started_at, et.duration_ms
         FROM execution_traces et
         WHERE et.tenant_id = $1
           AND et.call_session_id = ANY($2)
         ORDER BY et.started_at DESC
         LIMIT 50`,
        [tenantId, callIds],
      );
      recentTraces = rows;
    }

    await client.query('COMMIT');

    const toolCallsBySession = new Map<string, Record<string, unknown>[]>();
    for (const tc of activeToolCalls) {
      const sid = tc.call_session_id as string;
      if (!toolCallsBySession.has(sid)) toolCallsBySession.set(sid, []);
      toolCallsBySession.get(sid)!.push(tc);
    }

    const latestTraceBySession = new Map<string, Record<string, unknown>>();
    for (const t of recentTraces) {
      const sid = t.call_session_id as string;
      if (!latestTraceBySession.has(sid)) latestTraceBySession.set(sid, t);
    }

    const result = activeCalls.map((call: Record<string, unknown>) => {
      const latestTrace = latestTraceBySession.get(call.id as string);
      return {
        id: call.id,
        agentId: call.agent_id,
        agentName: call.agent_name ?? 'Unknown',
        agentSlug: call.agent_slug,
        direction: call.direction,
        lifecycleState: call.lifecycle_state,
        startTime: call.start_time,
        callerNumber: call.caller_number ? redactPHI(call.caller_number as string) : '***',
        workflowId: call.workflow_id,
        elapsedSeconds: call.elapsed_seconds,
        currentStep: latestTrace
          ? { traceType: latestTrace.trace_type, stepName: latestTrace.step_name, startedAt: latestTrace.started_at }
          : null,
        activeToolCalls: (toolCallsBySession.get(call.id as string) ?? []).map((tc: Record<string, unknown>) => ({
          id: tc.id,
          toolName: tc.tool_name,
          status: tc.status,
          invokedAt: tc.invoked_at,
        })),
      };
    });

    return res.json({
      activeCalls: result,
      totalActive: result.length,
      recentTraces: recentTraces.map((t: Record<string, unknown>) => ({
        id: t.id,
        callSessionId: t.call_session_id,
        traceType: t.trace_type,
        stepName: t.step_name,
        startedAt: t.started_at,
        durationMs: t.duration_ms,
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to get live board', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get live operations board' });
  } finally {
    client.release();
  }
}) as RequestHandler);

export default router;
