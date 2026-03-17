import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { redactPHI } from '../../../platform/core/phi/redact';
import { createLogger } from '../../../platform/core/logger';
import { getConversationCost } from '../../../platform/billing/cost';

const logger = createLogger('ADMIN_CALLS');

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

export const listCallsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { agent_id, direction, lifecycle_state, since } = req.query as Record<string, string>;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const conditions: string[] = ['cs.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (agent_id) { values.push(agent_id); conditions.push(`cs.agent_id = $${values.length}`); }
    if (direction) { values.push(direction); conditions.push(`cs.direction = $${values.length}`); }
    if (lifecycle_state) { values.push(lifecycle_state); conditions.push(`cs.lifecycle_state = $${values.length}`); }
    if (since) { values.push(since); conditions.push(`cs.start_time >= $${values.length}::timestamptz`); }

    const where = conditions.join(' AND ');
    const { rows } = await client.query(
      `SELECT cs.id, cs.agent_id, cs.direction, cs.lifecycle_state,
              cs.start_time, cs.end_time, cs.duration_seconds,
              cs.total_cost_cents, cs.environment, cs.created_at,
              a.name AS agent_name
       FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id
       WHERE ${where}
       ORDER BY cs.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM call_sessions cs WHERE ${where}`,
      values,
    );
    await client.query('COMMIT');

    return res.json({
      calls: rows,
      total: parseInt(countRows[0].total as string),
      limit,
      offset,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list calls', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list calls' });
  } finally {
    client.release();
  }
};

export const getCallHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT cs.*, a.name AS agent_name
       FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id
       WHERE cs.id = $1 AND cs.tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Call not found' });

    const call = rows[0] as Record<string, unknown>;
    if (call.caller_number) call.caller_number = redactPHI(call.caller_number as string);
    if (call.called_number) call.called_number = redactPHI(call.called_number as string);
    if (call.escalation_target) call.escalation_target = redactPHI(call.escalation_target as string);

    let costBreakdown = null;
    try {
      costBreakdown = await getConversationCost(tenantId, id);
    } catch {}

    return res.json({ call, costBreakdown });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to retrieve call' });
  } finally {
    client.release();
  }
};

const getTranscriptHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: sessionRows } = await client.query(
      `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (sessionRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Call not found' });
    }

    const { rows: lines } = await client.query(
      `SELECT id, role, content, sequence_number, occurred_at
       FROM call_transcripts
       WHERE call_session_id = $1 AND tenant_id = $2
       ORDER BY sequence_number ASC, occurred_at ASC`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    return res.json({ callId: id, transcript: lines });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get transcript', { tenantId, callId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve transcript' });
  } finally {
    client.release();
  }
};

const getCallEventsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: sessionRows } = await client.query(
      `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (sessionRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Call not found' });
    }

    const { rows: events } = await client.query(
      `SELECT id, event_type, from_state, to_state, payload, occurred_at
       FROM call_events
       WHERE call_session_id = $1 AND tenant_id = $2
       ORDER BY occurred_at ASC`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    return res.json({ callId: id, events });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get call events', { tenantId, callId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve call events' });
  } finally {
    client.release();
  }
};

const router = Router();
router.get('/calls', requireAuth, listCallsHandler);
router.get('/calls/:id', requireAuth, getCallHandler);
router.get('/calls/:id/transcript', requireAuth, getTranscriptHandler);
router.get('/calls/:id/events', requireAuth, getCallEventsHandler);

export default router;
