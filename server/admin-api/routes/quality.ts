import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { getCallQualityScore, getQualityAnalytics, getLowestScoringCalls } from '../../../platform/analytics';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_QUALITY');

router.get('/calls/:id/quality', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const score = await getCallQualityScore(tenantId, id);
    if (!score) {
      return res.status(404).json({ error: 'Quality score not found for this call' });
    }
    return res.json({ quality: score });
  } catch (err) {
    logger.error('Failed to get call quality', { tenantId, callId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to get call quality' });
  }
});

router.get('/analytics/quality', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const parsedDays = parseInt(String(req.query.days ?? '30'), 10);
  if (isNaN(parsedDays) || parsedDays < 1 || parsedDays > 90) {
    return res.status(400).json({ error: 'days must be between 1 and 90' });
  }
  const days = parsedDays;

  try {
    const [trends, lowestScoring] = await Promise.all([
      getQualityAnalytics(tenantId, days),
      getLowestScoringCalls(tenantId, 20),
    ]);
    return res.json({ trends, lowestScoring });
  } catch (err) {
    logger.error('Failed to get quality analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get quality analytics' });
  }
});

export default router;
