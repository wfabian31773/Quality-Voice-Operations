import { Router } from 'express';
import { pingDatabasePools } from '../../../platform/db';
import { createProbeRouter } from '../../../platform/runtime/health';
import { resolveProcessRole } from '../../../platform/runtime/processRole';
import { getBuildInfo } from '../../../platform/runtime/buildInfo';

const router = Router();

// PR-00: `/healthz` (liveness, Render healthCheckPath) and `/readyz`
// (env + DB + registries + not draining). `/health` below also carries the
// VA-14 deploy marker.
router.use(
  createProbeRouter({
    service: 'admin-api',
    role: () => resolveProcessRole(),
    dbPing: () => pingDatabasePools(),
  }),
);

router.get('/health', async (_req, res) => {
  let db: 'connected' | 'error' = 'error';
  try {
    await pingDatabasePools();
    db = 'connected';
  } catch {
    db = 'error';
  }

  const status = db === 'connected' ? 'healthy' : 'degraded';
  const { commit, buildTime, marker } = getBuildInfo();
  res.status(status === 'healthy' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    service: 'admin-api',
    version: '1.0.0',
    db,
    commit,
    buildTime,
    marker,
  });
});

export default router;
