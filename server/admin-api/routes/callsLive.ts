import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { requireAuth } from '../middleware/auth';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import {
  getTenantSseConnectionLimiter,
  attachSseHeartbeat,
  resolveLiveStreamCap,
  registerSseConnection,
  ackSseConnection,
} from '../../../platform/infra/rate-limit/sseConnectionLimiter';
import {
  BOOKKEEPING_FLUSH_TIMEOUT_MS,
  BOOKKEEPING_RELEASE_MAX_WAIT_MS,
  BOOKKEEPING_STATEMENT_TIMEOUT_MS,
} from '../../voice-gateway/services/bookkeepingQueue';
import type { Request } from 'express';

const logger = createLogger('CALLS_LIVE');
const router = Router();

const TENANT_LIVE_STREAM_CAP = resolveLiveStreamCap(process.env.TENANT_LIVE_STREAM_CAP);

export const callsLiveRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: TENANT_LIVE_STREAM_CAP,
  keyGenerator: (req: Request) =>
    (req as Request & { user?: { tenantId?: string } }).user?.tenantId ?? 'platform',
  message: 'Too many live-stream connection attempts for this tenant.',
});

/**
 * A final call stays in the poll for 10 s after its last update. Its
 * escalation_target write can land later than that: a tool run still open at
 * hangup queues its writes until release() (BOOKKEEPING_RELEASE_MAX_WAIT_MS,
 * 60 s; the 3 s finalize drain is inside it), then a flush
 * (BOOKKEEPING_FLUSH_TIMEOUT_MS, 5 s), then the escalation transaction itself:
 * UPDATE, ticket SAVEPOINT / SELECT / INSERT / RELEASE and the event row, six
 * statements of up to BOOKKEEPING_STATEMENT_TIMEOUT_MS (4 s) each, 24 s.
 * 60 + 5 + 24 = 89 s, rounded up to the next minute: 120 s.
 */
const LATE_ESCALATION_WORST_CASE_MS =
  BOOKKEEPING_RELEASE_MAX_WAIT_MS + BOOKKEEPING_FLUSH_TIMEOUT_MS + 6 * BOOKKEEPING_STATEMENT_TIMEOUT_MS;
/** How long a connection remembers a call that left the poll, so a late escalation still reaches the client. */
export const RECENT_CALL_RETENTION_MS = Math.ceil(LATE_ESCALATION_WORST_CASE_MS / 60_000) * 60_000;
/** Most calls a connection remembers that way; the oldest goes first. */
export const RECENT_CALL_MAX = 500;

interface RecentCall {
  state: string;
  escalated: boolean;
  leftAt: number;
}

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

  if (!getTenantSseConnectionLimiter().acquire(req, res)) {
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

  const connectionId = randomUUID();
  res.write(`event: connection\ndata: ${JSON.stringify({ connectionId })}\n\n`);

  const knownCalls = new Map<string, string>();
  const escalatedCalls = new Set<string>();
  // Calls that left the poll in the last RECENT_CALL_RETENTION_MS, oldest first.
  const recentCalls = new Map<string, RecentCall>();
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
      const now = Date.now();
      for (const [callId, recent] of recentCalls) {
        if (now - recent.leftAt <= RECENT_CALL_RETENTION_MS) break;
        recentCalls.delete(callId);
      }

      for (const row of rows) {
        currentIds.add(row.id);
        // A call back from recentCalls is known, not part of the initial snapshot.
        const recent = recentCalls.get(row.id);
        if (recent) {
          recentCalls.delete(row.id);
          knownCalls.set(row.id, recent.state);
          if (recent.escalated) escalatedCalls.add(row.id);
        }
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

        // A transfer that lands after the call is final keeps CALL_COMPLETED
        // and only sets escalation_target: still tell the client it escalated.
        if ((row.escalation_target || row.lifecycle_state === 'ESCALATED') && !escalatedCalls.has(row.id)) {
          escalatedCalls.add(row.id);
          if (prevState && row.lifecycle_state !== 'ESCALATED') {
            res.write(`event: call_escalated\ndata: ${JSON.stringify(row)}\n\n`);
          }
        }
      }

      for (const [callId, state] of knownCalls) {
        if (!currentIds.has(callId)) {
          recentCalls.set(callId, { state, escalated: escalatedCalls.has(callId), leftAt: now });
          knownCalls.delete(callId);
          escalatedCalls.delete(callId);
        }
      }
      for (const callId of recentCalls.keys()) {
        if (recentCalls.size <= RECENT_CALL_MAX) break;
        recentCalls.delete(callId);
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
  const unregister = registerSseConnection(tenantId, connectionId, detachHeartbeat.ack);

  req.on('close', () => {
    alive = false;
    clearInterval(interval);
    unregister();
    detachHeartbeat();
  });
});

router.post('/calls/live/ack', requireAuth, (req, res) => {
  const { tenantId } = req.user!;
  const connectionId =
    (req.body && typeof req.body === 'object' && (req.body as { connectionId?: unknown }).connectionId) ||
    req.query.connectionId;
  if (typeof connectionId !== 'string' || !connectionId) {
    return res.status(400).json({ error: 'connectionId required' });
  }
  const ok = ackSseConnection(tenantId, connectionId);
  if (!ok) return res.status(404).json({ error: 'unknown connectionId' });
  return res.status(204).end();
});

export default router;
