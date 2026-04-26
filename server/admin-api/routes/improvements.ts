import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  getSuggestions,
  getSuggestionById,
  acceptSuggestion,
  dismissSuggestion,
} from '../../../platform/analytics';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_IMPROVEMENTS');

router.get('/improvements/suggestions', requireAuth, requireRole('manager'), async (req, res) => {
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

router.get('/improvements/suggestions/:id', requireAuth, requireRole('manager'), async (req, res) => {
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

router.post('/improvements/suggestions/:id/accept', requireAuth, requireRole('manager'), async (req, res) => {
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

router.post('/improvements/suggestions/:id/dismiss', requireAuth, requireRole('manager'), async (req, res) => {
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

export default router;
