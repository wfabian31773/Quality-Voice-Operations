import { Router, type Response } from 'express';
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

/**
 * Proxy a JSON metrics endpoint on the voice gateway (admin-token gated there)
 * out to a platform admin here. The gateway's diagnostic/metrics state lives in
 * its own process memory, so the admin API fetches it over the internal hop.
 * Maps upstream conditions to honest statuses: 503 (admin token missing here),
 * 502 (gateway error/unreachable), 504 (gateway timeout).
 */
async function proxyGatewayJson(gatewayPath: string, res: Response): Promise<void> {
  const adminToken = process.env.ADMIN_INTERNAL_TOKEN;
  if (!adminToken) {
    logger.error('ADMIN_INTERNAL_TOKEN not configured — cannot fetch voice gateway metrics');
    res.status(503).json({
      error: 'Voice gateway metrics unavailable: ADMIN_INTERNAL_TOKEN not configured on the admin API',
    });
    return;
  }

  const url = `${getVoiceGatewayBaseUrl()}${gatewayPath}`;
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
        path: gatewayPath, status: upstream.status, body: body.slice(0, 200),
      });
      res.status(502).json({ error: 'Voice gateway returned an error', status: upstream.status });
      return;
    }
    const data = (await upstream.json()) as Record<string, unknown>;
    res.json(data);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    logger.error('Failed to fetch metrics from voice gateway', { url, error: String(err) });
    res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'Voice gateway timed out while returning metrics' : 'Failed to reach voice gateway for metrics',
    });
  } finally {
    clearTimeout(timeout);
  }
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
  (_req, res) => proxyGatewayJson('/admin/twilio-webhook-security', res),
);

// Realtime voice-stream telemetry (latency p50/p95/max + failures by stage),
// surfaced for the platform-admin dashboard. Proxies the gateway's in-process
// snapshot at /admin/diagnostics/realtime-stream/metrics.
router.get(
  '/observability/realtime-stream',
  requireAuth,
  requirePlatformAdmin,
  (_req, res) => proxyGatewayJson('/admin/diagnostics/realtime-stream/metrics', res),
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
