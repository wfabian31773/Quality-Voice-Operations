import { Router } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { createProbeRouter } from '../../../platform/runtime/health';
import { resolveProcessRole } from '../../../platform/runtime/processRole';

const router = Router();

// PR-00: `/healthz` (liveness, Render healthCheckPath) and `/readyz`
// (env + DB + registries + not draining). `/health` below is unchanged.
router.use(
  createProbeRouter({
    service: 'admin-api',
    role: () => resolveProcessRole(),
    dbPing: () => getPlatformPool().query('SELECT 1'),
  }),
);

router.get('/health', async (_req, res) => {
  let db: 'connected' | 'error' = 'error';
  try {
    const pool = getPlatformPool();
    await pool.query('SELECT 1');
    db = 'connected';
  } catch {
    db = 'error';
  }

  const status = db === 'connected' ? 'healthy' : 'degraded';
  res.status(status === 'healthy' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    service: 'admin-api',
    version: '1.0.0',
    db,
  });
});

export default router;
