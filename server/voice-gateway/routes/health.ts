import { Router } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { sessionManager } from '../services/sessionManager';

const router = Router();

router.get('/health', async (_req, res) => {
  try {
    const pool = getPlatformPool();
    const result = await pool.query('SELECT 1 AS ok');
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

router.get('/metrics', (_req, res) => {
  const metrics = sessionManager.getMetrics();
  res.json({
    timestamp: new Date().toISOString(),
    ...metrics,
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

export default router;
