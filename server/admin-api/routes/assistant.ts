import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import { chat, getSessions, getAnalytics } from '../../../platform/assistant/PlatformAssistantService';

const router = Router();
const logger = createLogger('ADMIN_ASSISTANT');

router.post('/assistant/chat', requireAuth, async (req, res) => {
  const { tenantId, userId, role } = req.user!;
  const { message, sessionId, pageContext } = req.body as {
    message?: string;
    sessionId?: string;
    pageContext?: string;
  };

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ error: 'message must be 2000 characters or fewer' });
  }

  try {
    const result = await chat(tenantId, userId, role || 'member', sessionId || null, message.trim(), pageContext);
    return res.json(result);
  } catch (err) {
    logger.error('Assistant chat failed', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Assistant is temporarily unavailable' });
  }
});

router.get('/assistant/sessions', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 50);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const offset = (page - 1) * limit;

  try {
    const result = await getSessions(tenantId, userId, limit, offset);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to list assistant sessions', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list sessions' });
  }
});

router.get('/assistant/analytics', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const analytics = await getAnalytics(tenantId);
    return res.json(analytics);
  } catch (err) {
    logger.error('Failed to get assistant analytics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get analytics' });
  }
});

export default router;
