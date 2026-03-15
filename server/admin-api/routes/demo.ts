import { Router, type Request, type Response } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';

const router = Router();

const DEMO_TENANT_ID = 'demo';

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.socket?.remoteAddress ?? 'unknown';
}

const demoActivityLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  message: 'Too many demo requests. Please try again shortly.',
  keyGenerator: (req) => `demo:${getClientIp(req)}`,
});

function mapEventType(raw: string): string {
  const map: Record<string, string> = {
    call_received: 'call_started',
    agent_connected: 'call_started',
    workflow_execution_start: 'workflow_triggered',
    tool_start: 'workflow_triggered',
    tool_end: 'workflow_triggered',
    escalation_active: 'workflow_triggered',
    escalation_success: 'workflow_triggered',
    escalation_failed: 'workflow_triggered',
    call_completed: 'call_ended',
    session_closed: 'call_ended',
  };
  return map[raw.toLowerCase()] ?? raw.toLowerCase();
}

router.get('/demo/activity', demoActivityLimiter, async (_req: Request, res: Response) => {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT
         ce.id,
         ce.event_type,
         a.name AS agent_name,
         cs.duration_seconds,
         ce.occurred_at
       FROM call_events ce
       JOIN call_sessions cs ON cs.id = ce.call_session_id
       JOIN agents a ON a.id = cs.agent_id
       WHERE ce.tenant_id = $1
         AND LOWER(ce.event_type) IN ('call_received', 'agent_connected', 'workflow_execution_start', 'tool_start', 'tool_end', 'call_completed', 'session_closed', 'escalation_active', 'escalation_success', 'escalation_failed')
       ORDER BY ce.occurred_at DESC
       LIMIT 10`,
      [DEMO_TENANT_ID],
    );

    const events = rows.map((row) => {
      const mapped = mapEventType(row.event_type as string);
      return {
        id: row.id as string,
        eventType: mapped,
        agentName: row.agent_name as string,
        durationSeconds: mapped === 'call_ended' ? (row.duration_seconds as number | null) : null,
        timestamp: row.occurred_at as string,
      };
    });

    res.json({ events });
  } catch (err) {
    console.error('[DEMO] Failed to fetch activity:', err);
    res.status(500).json({ error: 'Failed to fetch demo activity' });
  }
});

router.get('/demo/stats', demoActivityLimiter, async (_req: Request, res: Response) => {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT demo_call_count FROM tenants WHERE id = $1`,
      [DEMO_TENANT_ID],
    );

    const totalCalls = rows[0]?.demo_call_count ?? 0;

    const { rows: sessionCount } = await pool.query(
      `SELECT COUNT(*) AS count FROM call_sessions WHERE tenant_id = $1`,
      [DEMO_TENANT_ID],
    );

    res.json({
      totalCalls: Math.max(totalCalls as number, parseInt(sessionCount[0]?.count as string, 10)),
    });
  } catch (err) {
    console.error('[DEMO] Failed to fetch stats:', err);
    res.status(500).json({ error: 'Failed to fetch demo stats' });
  }
});

export default router;
