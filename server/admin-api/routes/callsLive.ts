import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('CALLS_LIVE');
const router = Router();

function getJwtSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    const IS_PROD = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').startsWith('prod');
    if (IS_PROD) throw new Error('ADMIN_JWT_SECRET is required in production');
    return 'dev-only-insecure-jwt-secret-DO-NOT-USE';
  }
  return secret;
}

function sseAuth(req: Request, res: Response, next: NextFunction): void {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies?.auth_token) {
    token = req.cookies.auth_token as string;
  }

  if (!token) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as Record<string, unknown>;
    req.user = {
      userId: payload.sub as string,
      tenantId: payload.tenantId as string,
      email: payload.email as string,
      role: (payload.role as string) ?? 'member',
      isPlatformAdmin: (payload.isPlatformAdmin as boolean) ?? false,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

interface ActiveCallRow {
  id: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  agent_id: string;
  agent_name: string | null;
  caller_number: string | null;
  escalation_target: string | null;
}

router.get('/calls/live', sseAuth, async (req, res) => {
  const { tenantId } = req.user!;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(':\n\n');

  let lastSnapshot: string | null = null;
  let alive = true;

  const sendSnapshot = async () => {
    if (!alive) return;
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const { rows } = await client.query<ActiveCallRow>(
        `SELECT cs.id, cs.direction, cs.lifecycle_state, cs.start_time,
                cs.agent_id, a.name AS agent_name, cs.caller_number,
                cs.escalation_target
         FROM call_sessions cs
         LEFT JOIN agents a ON a.id = cs.agent_id AND a.tenant_id = cs.tenant_id
         WHERE cs.tenant_id = $1
           AND cs.lifecycle_state NOT IN ('CALL_COMPLETED', 'CALL_FAILED', 'WORKFLOW_FAILED', 'ESCALATION_FAILED')
         ORDER BY cs.start_time DESC
         LIMIT 50`,
        [tenantId],
      );

      await client.query('COMMIT');

      const snapshot = JSON.stringify(rows);
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        res.write(`event: active_calls\ndata: ${snapshot}\n\n`);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('SSE snapshot failed', { tenantId, error: String(err) });
    } finally {
      client.release();
    }
  };

  await sendSnapshot();

  const interval = setInterval(sendSnapshot, 3000);

  const heartbeat = setInterval(() => {
    if (alive) res.write(':\n\n');
  }, 15000);

  req.on('close', () => {
    alive = false;
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

export default router;
