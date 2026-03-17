import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  analyzeCallAndGenerateSuggestions,
  getSuggestions,
  getSuggestionById,
  acceptSuggestion,
  dismissSuggestion,
  getImprovementVelocity,
  getCategoryBreakdown,
  getCallQualityScore,
} from '../../../platform/analytics';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_IMPROVEMENTS');

router.post('/improvements/analyze', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { agentId, callSessionId } = req.body as { agentId?: string; callSessionId?: string };

  if (!agentId || !callSessionId) {
    return res.status(400).json({ error: 'agentId and callSessionId are required' });
  }

  try {
    const qualityScore = await getCallQualityScore(tenantId, callSessionId);
    if (qualityScore && qualityScore.score >= 8.0) {
      return res.json({ suggestions: [], message: 'Call quality score is already high (>= 8.0). No improvements needed.' });
    }

    const suggestions = await analyzeCallAndGenerateSuggestions(tenantId, agentId, callSessionId);
    return res.json({ suggestions });
  } catch (err) {
    logger.error('Failed to analyze call for improvements', { tenantId, agentId, callSessionId, error: String(err) });
    return res.status(500).json({ error: 'Failed to analyze call' });
  }
});

router.get('/improvements/suggestions', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const agentId = req.query.agentId as string | undefined;
  const status = req.query.status as string | undefined;
  const limitRaw = parseInt(String(req.query.limit ?? '50'), 10);
  const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(limitRaw, 1), 100);

  try {
    const validStatuses = ['pending', 'accepted', 'dismissed'];
    const statusFilter = status && validStatuses.includes(status) ? status as 'pending' | 'accepted' | 'dismissed' : undefined;
    const suggestions = await getSuggestions(tenantId, agentId, statusFilter, limit);
    return res.json({ suggestions });
  } catch (err) {
    logger.error('Failed to get suggestions', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

router.get('/improvements/suggestions/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const suggestion = await getSuggestionById(tenantId, id);
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    return res.json({ suggestion });
  } catch (err) {
    logger.error('Failed to get suggestion', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to get suggestion' });
  }
});

router.post('/improvements/suggestions/:id/accept', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;

  try {
    const suggestion = await acceptSuggestion(tenantId, id, userId);
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found or already processed' });
    }
    return res.json({ suggestion });
  } catch (err) {
    logger.error('Failed to accept suggestion', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to accept suggestion' });
  }
});

router.post('/improvements/suggestions/:id/dismiss', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;

  try {
    const suggestion = await dismissSuggestion(tenantId, id, userId);
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found or already processed' });
    }
    return res.json({ suggestion });
  } catch (err) {
    logger.error('Failed to dismiss suggestion', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to dismiss suggestion' });
  }
});

router.get('/improvements/velocity', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const agentId = req.query.agentId as string | undefined;
  const daysRaw = parseInt(String(req.query.days ?? '90'), 10);
  const days = Number.isNaN(daysRaw) ? 90 : Math.min(Math.max(daysRaw, 1), 365);

  try {
    const velocity = await getImprovementVelocity(tenantId, agentId, days);
    return res.json({ velocity });
  } catch (err) {
    logger.error('Failed to get improvement velocity', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get improvement velocity' });
  }
});

router.get('/improvements/categories', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const agentId = req.query.agentId as string | undefined;
  const daysRaw = parseInt(String(req.query.days ?? '90'), 10);
  const days = Number.isNaN(daysRaw) ? 90 : Math.min(Math.max(daysRaw, 1), 365);

  try {
    const categories = await getCategoryBreakdown(tenantId, agentId, days);
    return res.json({ categories });
  } catch (err) {
    logger.error('Failed to get category breakdown', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get category breakdown' });
  }
});

export default router;
