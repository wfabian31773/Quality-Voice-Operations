import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { getTenantMetrics, getRecentErrors, getSystemMetrics } from '../../../platform/core/observability';

const logger = createLogger('OBSERVABILITY_API');
const router = Router();

router.get('/observability/metrics', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const windowParam = String(req.query.window ?? '7d');
  let windowDays = 7;
  if (windowParam === '24h' || windowParam === '1d') windowDays = 1;
  else if (windowParam === '7d') windowDays = 7;
  else if (windowParam === '30d') windowDays = 30;

  try {
    const metrics = await getTenantMetrics(tenantId, windowDays);
    return res.json({ window: windowParam, ...metrics });
  } catch (err) {
    logger.error('Failed to fetch observability metrics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

router.get('/observability/errors', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);

  try {
    const errors = await getRecentErrors(tenantId, limit);
    return res.json({ errors });
  } catch (err) {
    logger.error('Failed to fetch error logs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch error logs' });
  }
});

router.get('/observability/system', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const system = await getSystemMetrics();
    return res.json(system);
  } catch (err) {
    logger.error('Failed to fetch system metrics', { error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch system metrics' });
  }
});

export default router;
