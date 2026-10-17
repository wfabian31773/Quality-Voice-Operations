import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { pingDatabasePools } from '../../../platform/db';
import { createProbeRouter } from '../../../platform/runtime/health';
import { resolveProcessRole } from '../../../platform/runtime/processRole';
import { sessionManager } from '../services/sessionManager';

const router = Router();

// Same `x-admin-token` (ADMIN_INTERNAL_TOKEN) contract as the other
// voice-gateway admin routes, compared in constant time.
function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.ADMIN_INTERNAL_TOKEN;
  if (!adminToken) {
    res.status(503).json({ error: 'Admin endpoint not available: missing server configuration' });
    return;
  }
  const provided = req.headers['x-admin-token'];
  const a = Buffer.from(typeof provided === 'string' ? provided : '');
  const b = Buffer.from(adminToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

router.use(
  createProbeRouter({
    service: 'voice-gateway',
    role: () => resolveProcessRole(),
    dbPing: () => pingDatabasePools(),
    isDraining: () => sessionManager.isDraining(),
  }),
);

router.get('/health', async (_req, res) => {
  try {
    const result = await pingDatabasePools('SELECT 1 AS ok');
    const dbOk = result.rows[0]?.ok === 1;

    res.json({
      status: dbOk ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.1.0',
      db: dbOk ? 'connected' : 'unreachable',
      activeSessions: sessionManager.getActiveCount(),
      draining: sessionManager.isDraining(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Database unreachable',
    });
  }
});

router.get('/metrics', requireAdminToken, (_req, res) => {
  const metrics = sessionManager.getMetrics();
  res.json({
    timestamp: new Date().toISOString(),
    ...metrics,
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

// Polled by scripts/render/deploy.ts before a voice deploy (waits for 0).
router.get('/internal/drain-status', requireAdminToken, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(sessionManager.getDrainStatus());
});

export default router;
