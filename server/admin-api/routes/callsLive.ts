import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { requireAuth } from '../middleware/auth';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import {
  createSseConnectionLimiter,
  attachSseHeartbeat,
  resolveLiveStreamCap,
} from '../../../platform/infra/rate-limit/sseConnectionLimiter';
import type { Request } from 'express';

const logger = createLogger('CALLS_LIVE');
const router = Router();

const TENANT_LIVE_STREAM_CAP = resolveLiveStreamCap(process.env.TENANT_LIVE_STREAM_CAP);

// Per-task spec: reuse createRateLimiter keyed on req.user.tenantId. This
// guards the connection-open endpoint at request rate (20 opens / 60s) so a
// single tenant cannot stampede the SSE port.
export const callsLiveRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: TENANT_LIVE_STREAM_CAP,
  keyGenerator: (req: Request) =>
    (req as Request & { user?: { tenantId?: string } }).user?.tenantId ?? 'platform',
  message: 'Too many live-stream connection attempts for this tenant.',
});

// Concurrency cap: enforces *simultaneously open* connections, which is what
// "concurrent" means semantically and what request-rate alone cannot capture.
export const callsLiveSseLimiter = createSseConnectionLimiter({
  maxConcurrent: TENANT_LIVE_STREAM_CAP,
});

interface CallRow {
  id: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  end_time: string | null;
  agent_id: string;
  agent_name: string | null;
  caller_number: string | null;
  escalation_target: string | null;
  duration_seconds: number | null;
}

router.get('/calls/live', requireAuth, callsLiveRateLimiter, async (req, res) => {
  const { tenantId } = req.user!;

  if (!callsLiveSseLimiter.acquire(req, res)) {
    logger.warn('Rejected live-stream connection — tenant concurrency cap reached', {
      tenantId,
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

  res.write(':\n\n');

  const knownCalls = new Map<string, string>();
  let alive = true;

  const poll = async () => {
    if (!alive) return;
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const { rows } = await client.query<CallRow>(
        `SELECT cs.id, cs.direction, cs.lifecycle_state, cs.start_time, cs.end_time,
                cs.agent_id, a.name AS agent_name, cs.caller_number,
                cs.escalation_target, cs.duration_seconds
         FROM call_sessions cs
         LEFT JOIN agents a ON a.id = cs.agent_id AND a.tenant_id = cs.tenant_id
         WHERE cs.tenant_id = $1
           AND (cs.lifecycle_state NOT IN ('CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED')
                OR cs.updated_at > NOW() - INTERVAL '10 seconds')
         ORDER BY cs.start_time DESC
         LIMIT 50`,
        [tenantId],
      );

      await client.query('COMMIT');

      const currentIds = new Set<string>();

      for (const row of rows) {
        currentIds.add(row.id);
        const prevState = knownCalls.get(row.id);

        if (!prevState) {
          knownCalls.set(row.id, row.lifecycle_state);
          if (row.lifecycle_state === 'CALL_RECEIVED') {
            res.write(`event: call_started\ndata: ${JSON.stringify(row)}\n\n`);
          } else if (row.lifecycle_state === 'AGENT_CONNECTED' || row.lifecycle_state === 'ACTIVE_CONVERSATION') {
            res.write(`event: call_connected\ndata: ${JSON.stringify(row)}\n\n`);
          } else if (row.lifecycle_state === 'CALL_COMPLETED') {
            res.write(`event: call_completed\ndata: ${JSON.stringify(row)}\n\n`);
          } else if (row.lifecycle_state === 'CALL_FAILED' || row.lifecycle_state === 'WORKFLOW_FAILED' || row.lifecycle_state === 'ESCALATION_FAILED') {
            res.write(`event: call_failed\ndata: ${JSON.stringify(row)}\n\n`);
          } else {
            res.write(`event: call_updated\ndata: ${JSON.stringify(row)}\n\n`);
          }
        } else if (prevState !== row.lifecycle_state) {
          knownCalls.set(row.id, row.lifecycle_state);
          if (row.lifecycle_state === 'AGENT_CONNECTED' || row.lifecycle_state === 'ACTIVE_CONVERSATION') {
            res.write(`event: call_connected\ndata: ${JSON.stringify(row)}\n\n`);
          } else if (row.lifecycle_state === 'CALL_COMPLETED') {
            res.write(`event: call_completed\ndata: ${JSON.stringify(row)}\n\n`);
          } else if (row.lifecycle_state === 'CALL_FAILED' || row.lifecycle_state === 'WORKFLOW_FAILED' || row.lifecycle_state === 'ESCALATION_FAILED') {
            res.write(`event: call_failed\ndata: ${JSON.stringify(row)}\n\n`);
          } else if (row.lifecycle_state === 'ESCALATED') {
            res.write(`event: call_escalated\ndata: ${JSON.stringify(row)}\n\n`);
          } else {
            res.write(`event: call_updated\ndata: ${JSON.stringify(row)}\n\n`);
          }
        }
      }

      for (const [callId] of knownCalls) {
        if (!currentIds.has(callId)) {
          knownCalls.delete(callId);
        }
      }

      const activeCalls = rows.filter(
        (r) => !['CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED'].includes(r.lifecycle_state),
      );
      res.write(`event: active_calls\ndata: ${JSON.stringify(activeCalls)}\n\n`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('SSE poll failed', { tenantId, error: String(err) });
    } finally {
      client.release();
    }
  };

  await poll();

  const interval = setInterval(poll, 3000);

  const detachHeartbeat = attachSseHeartbeat(req, res, {
    intervalMs: 15_000,
    idleTimeoutMs: 60_000,
  });

  req.on('close', () => {
    alive = false;
    clearInterval(interval);
    detachHeartbeat();
  });
});

export default router;
