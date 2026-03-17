import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import {
  getCallAnalytics,
  getCampaignAnalytics,
  getAgentAnalytics,
  getCostAnalytics,
  getRevenueAttribution,
  getSentimentTrends,
  getAgentSentiments,
  getTopicDistribution,
  getTopicTrends,
  getConversionFunnel,
  getConversionTrends,
  getQualityAnalytics,
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

router.get('/analytics/revenue', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  const rawTicketValue = parseInt(String(req.query.avgTicketValueCents ?? '15000'), 10);
  const avgTicketValueCents = Number.isFinite(rawTicketValue) && rawTicketValue > 0 ? rawTicketValue : 15000;

  try {
    const result = await getRevenueAttribution(tenantId, dateRange.from, dateRange.to, avgTicketValueCents);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch revenue attribution', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch revenue attribution' });
  }
});

router.get('/analytics/sentiment', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const [trends, agentSentiments] = await Promise.all([
      getSentimentTrends(tenantId, dateRange.from, dateRange.to),
      getAgentSentiments(tenantId, dateRange.from, dateRange.to),
    ]);
    return res.json({ trends, agentSentiments });
  } catch (err) {
    logger.error('Failed to fetch sentiment analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch sentiment analytics' });
  }
});

router.get('/analytics/topics', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const [distribution, trends] = await Promise.all([
      getTopicDistribution(tenantId, dateRange.from, dateRange.to),
      getTopicTrends(tenantId, dateRange.from, dateRange.to),
    ]);
    return res.json({ distribution, trends });
  } catch (err) {
    logger.error('Failed to fetch topic analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch topic analytics' });
  }
});

router.get('/analytics/funnel', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  try {
    const [funnel, trends] = await Promise.all([
      getConversionFunnel(tenantId, dateRange.from, dateRange.to),
      getConversionTrends(tenantId, dateRange.from, dateRange.to),
    ]);
    return res.json({ funnel, trends });
  } catch (err) {
    logger.error('Failed to fetch funnel analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch funnel analytics' });
  }
});

router.get('/analytics/performance', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const dateRange = parseDateRange(req.query as Record<string, unknown>);
  if (!dateRange) {
    return res.status(400).json({ error: 'Invalid date parameters' });
  }

  const rawTicketValue2 = parseInt(String(req.query.avgTicketValueCents ?? '15000'), 10);
  const avgTicketValueCents = Number.isFinite(rawTicketValue2) && rawTicketValue2 > 0 ? rawTicketValue2 : 15000;

  const rangeDays = Math.ceil((dateRange.to.getTime() - dateRange.from.getTime()) / (24 * 60 * 60 * 1000));

  try {
    const [revenue, sentimentData, topicData, funnel, qualityTrends] = await Promise.all([
      getRevenueAttribution(tenantId, dateRange.from, dateRange.to, avgTicketValueCents),
      getSentimentTrends(tenantId, dateRange.from, dateRange.to).then(async (trends) => {
        const agentSentiments = await getAgentSentiments(tenantId, dateRange.from, dateRange.to);
        return { trends, agentSentiments };
      }),
      getTopicDistribution(tenantId, dateRange.from, dateRange.to),
      getConversionFunnel(tenantId, dateRange.from, dateRange.to),
      getQualityAnalytics(tenantId, rangeDays),
    ]);

    return res.json({
      revenue,
      sentiment: sentimentData,
      topics: topicData,
      funnel,
      qualityTrends,
    });
  } catch (err) {
    logger.error('Failed to fetch performance analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch performance analytics' });
  }
});

export default router;
