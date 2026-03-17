import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import {
  getIndustryBenchmarks,
  getTenantBenchmarkComparison,
  getAllIndustryVerticals,
  getGlobalPatterns,
  getGlobalPromptPatterns,
  getTenantRecommendations,
  updateRecommendationStatus,
  getGinParticipation,
  updateGinParticipation,
  getAggregationRuns,
  getPolicyAcceptanceHistory,
} from '../../../platform/gin';

const logger = createLogger('GIN_API');
const router = Router();

router.get('/gin/benchmarks', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const comparison = await getTenantBenchmarkComparison(tenantId);
    return res.json(comparison);
  } catch (err) {
    logger.error('Failed to fetch benchmarks', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch benchmarks' });
  }
});

router.get('/gin/benchmarks/:vertical', requireAuth, async (req, res) => {
  const { vertical } = req.params;

  try {
    const benchmarks = await getIndustryBenchmarks(vertical);
    return res.json({ benchmarks });
  } catch (err) {
    logger.error('Failed to fetch industry benchmarks', { vertical, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch industry benchmarks' });
  }
});

router.get('/gin/verticals', requireAuth, async (_req, res) => {
  try {
    const verticals = await getAllIndustryVerticals();
    return res.json({ verticals });
  } catch (err) {
    logger.error('Failed to fetch verticals', { error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch verticals' });
  }
});

router.get('/gin/patterns', requireAuth, async (req, res) => {
  const patternType = req.query.type ? String(req.query.type) : undefined;
  const industry = req.query.industry ? String(req.query.industry) : undefined;
  const parsedLimit = parseInt(String(req.query.limit ?? '50'), 10);
  const limit = Math.min(isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit, 100);

  try {
    const result = await getGlobalPatterns({ patternType, industry, limit });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch patterns', { error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch patterns' });
  }
});

router.get('/gin/prompt-patterns', requireAuth, async (req, res) => {
  const category = req.query.category ? String(req.query.category) : undefined;
  const industry = req.query.industry ? String(req.query.industry) : undefined;

  try {
    const patterns = await getGlobalPromptPatterns({ category, industry });
    return res.json({ patterns });
  } catch (err) {
    logger.error('Failed to fetch prompt patterns', { error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch prompt patterns' });
  }
});

router.get('/gin/recommendations', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const status = req.query.status ? String(req.query.status) : undefined;
  const parsedLimit = parseInt(String(req.query.limit ?? '50'), 10);
  const limit = Math.min(isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit, 100);

  try {
    const result = await getTenantRecommendations(tenantId, { status, limit });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch recommendations', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

router.post('/gin/recommendations/:id/status', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !['applied', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Status must be "applied" or "dismissed"' });
  }

  try {
    const rec = await updateRecommendationStatus(tenantId, id, status);
    if (!rec) {
      return res.status(404).json({ error: 'Recommendation not found' });
    }
    return res.json({ recommendation: rec });
  } catch (err) {
    logger.error('Failed to update recommendation status', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update recommendation status' });
  }
});

router.get('/gin/participation', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const settings = await getGinParticipation(tenantId);
    return res.json(settings);
  } catch (err) {
    logger.error('Failed to fetch GIN participation', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch participation settings' });
  }
});

router.post('/gin/participation', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { participate, acceptDataUsage } = req.body;

  if (typeof participate !== 'boolean') {
    return res.status(400).json({ error: 'participate must be a boolean' });
  }

  try {
    const settings = await updateGinParticipation(tenantId, participate, acceptDataUsage ?? false, userId);
    return res.json(settings);
  } catch (err) {
    logger.error('Failed to update GIN participation', { tenantId, error: String(err) });
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/gin/policy-history', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const records = await getPolicyAcceptanceHistory(tenantId);
    return res.json({ records });
  } catch (err) {
    logger.error('Failed to fetch policy history', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch policy history' });
  }
});

router.get('/gin/runs', requireAuth, async (_req, res) => {
  try {
    const runs = await getAggregationRuns(20);
    return res.json({ runs });
  } catch (err) {
    logger.error('Failed to fetch aggregation runs', { error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch aggregation runs' });
  }
});

export default router;
