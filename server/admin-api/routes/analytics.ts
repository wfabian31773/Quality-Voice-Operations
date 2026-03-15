import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import {
  getCallAnalytics,
  getCampaignAnalytics,
  getAgentAnalytics,
  getCostAnalytics,
} from '../../../platform/analytics';

const logger = createLogger('ANALYTICS_API');
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

router.get('/analytics/calls', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const result = await getCallAnalytics(tenantId, dateRange.from, dateRange.to);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch call analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch call analytics' });
  }
});

router.get('/analytics/campaigns', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const result = await getCampaignAnalytics(tenantId, dateRange.from, dateRange.to);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch campaign analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch campaign analytics' });
  }
});

router.get('/analytics/agents', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const result = await getAgentAnalytics(tenantId, dateRange.from, dateRange.to);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch agent analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch agent analytics' });
  }
});

router.get('/analytics/costs', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const result = await getCostAnalytics(tenantId, dateRange.from, dateRange.to);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch cost analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch cost analytics' });
  }
});

export default router;
