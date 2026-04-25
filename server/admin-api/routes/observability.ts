import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { getTenantMetrics, getRecentErrors, getSystemMetrics } from '../../../platform/core/observability';

const logger = createLogger('OBSERVABILITY_API');
const router = Router();

function getVoiceGatewayBaseUrl(): string {
  const explicit = process.env.VOICE_GATEWAY_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) return `https://${devDomain}`;
  return 'http://localhost:3001';
}

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

router.get(
  '/observability/twilio-webhook-security',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    const adminToken = process.env.ADMIN_INTERNAL_TOKEN;
    if (!adminToken) {
      logger.error('ADMIN_INTERNAL_TOKEN not configured — cannot fetch voice gateway metrics');
      return res.status(503).json({
        error:
          'Voice gateway metrics unavailable: ADMIN_INTERNAL_TOKEN not configured on the admin API',
      });
    }

    const url = `${getVoiceGatewayBaseUrl()}/admin/twilio-webhook-security`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const upstream = await fetch(url, {
        headers: { 'x-admin-token': adminToken, accept: 'application/json' },
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const body = await upstream.text().catch(() => '');
        logger.error('Voice gateway returned non-OK for metrics snapshot', {
          status: upstream.status,
          body: body.slice(0, 200),
        });
        return res
          .status(502)
          .json({ error: 'Voice gateway returned an error', status: upstream.status });
      }

      const data = (await upstream.json()) as Record<string, unknown>;
      return res.json(data);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      logger.error('Failed to fetch twilio signature metrics from voice gateway', {
        url,
        error: String(err),
      });
      return res.status(isAbort ? 504 : 502).json({
        error: isAbort
          ? 'Voice gateway timed out while returning metrics'
          : 'Failed to reach voice gateway for metrics',
      });
    } finally {
      clearTimeout(timeout);
    }
  },
);

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
