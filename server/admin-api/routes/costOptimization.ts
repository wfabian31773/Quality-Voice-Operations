import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import {
  getCostOptimizationAnalytics,
  getConversationCosts,
  getCostBudgetSettings,
  upsertCostBudgetSettings,
  getCacheStats,
  getRoutingDistribution,
  getConversationCost,
} from '../../../platform/billing/cost';

const logger = createLogger('COST_OPTIMIZATION_API');
const router = Router();

function parseDateRange(query: Record<string, unknown>): { from: Date; to: Date } | null {
  const now = new Date();

  let to: Date;
  if (query.to) {
    to = new Date(String(query.to));
    if (isNaN(to.getTime())) return null;
  } else {
    to = now;
  }

  if (query.from) {
    const from = new Date(String(query.from));
    if (isNaN(from.getTime())) return null;
    return { from, to };
  }

  const range = String(query.range ?? '30d');
  let days = 30;
  if (range === '7d') days = 7;
  else if (range === '30d') days = 30;
  else if (range === '90d') days = 90;

  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

router.get('/cost-optimization/analytics', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const result = await getCostOptimizationAnalytics(tenantId, dateRange.from, dateRange.to);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch cost optimization analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch cost analytics' });
  }
});

router.get('/cost-optimization/conversations', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 100);
  const offset = parseInt(String(req.query.offset ?? '0'), 10);

  try {
    const result = await getConversationCosts(tenantId, dateRange.from, dateRange.to, limit, offset);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch conversation costs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch conversation costs' });
  }
});

router.get('/cost-optimization/conversation/:sessionId', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { sessionId } = req.params;

  try {
    const result = await getConversationCost(tenantId, sessionId);
    if (!result) {
      return res.status(404).json({ error: 'Cost record not found' });
    }
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch conversation cost', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch conversation cost' });
  }
});

router.get('/cost-optimization/budget', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const settings = await getCostBudgetSettings(tenantId);
    return res.json(settings ?? {
      tenantId,
      maxCostPerConversationCents: 500,
      alertThresholdPercent: 80,
      autoDowngradeModel: true,
      autoEndCall: false,
      enabled: false,
    });
  } catch (err) {
    logger.error('Failed to fetch budget settings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch budget settings' });
  }
});

router.put('/cost-optimization/budget', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { maxCostPerConversationCents, alertThresholdPercent, autoDowngradeModel, autoEndCall, enabled } = req.body;

  try {
    const result = await upsertCostBudgetSettings(tenantId, {
      maxCostPerConversationCents,
      alertThresholdPercent,
      autoDowngradeModel,
      autoEndCall,
      enabled,
    });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to update budget settings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update budget settings' });
  }
});

router.get('/cost-optimization/cache-stats', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const stats = await getCacheStats(tenantId, dateRange.from, dateRange.to);
    return res.json(stats);
  } catch (err) {
    logger.error('Failed to fetch cache stats', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch cache stats' });
  }
});

router.get('/cost-optimization/routing-distribution', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const distribution = await getRoutingDistribution(tenantId, dateRange.from, dateRange.to);
    return res.json(distribution);
  } catch (err) {
    logger.error('Failed to fetch routing distribution', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch routing distribution' });
  }
});

export default router;
