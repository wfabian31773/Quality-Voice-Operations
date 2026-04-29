import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  getTenantCsatSettings,
  updateTenantCsatSettings,
  validateCsatSettingsUpdate,
  listRecentCsatResponses,
  type UpdateTenantCsatSettingsInput,
} from '../../../platform/analytics';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_CSAT');

router.get('/csat/settings', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const settings = await getTenantCsatSettings(tenantId);
    return res.json({ settings });
  } catch (err) {
    logger.error('Failed to load CSAT settings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to load CSAT settings' });
  }
});

router.patch('/csat/settings', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = (req.body ?? {}) as UpdateTenantCsatSettingsInput;

  const reason = validateCsatSettingsUpdate(body);
  if (reason) {
    return res.status(400).json({ error: reason });
  }

  try {
    const settings = await updateTenantCsatSettings(tenantId, body);
    return res.json({ settings });
  } catch (err) {
    logger.error('Failed to update CSAT settings', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update CSAT settings' });
  }
});

router.get('/csat/responses/recent', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const parsedLimit = parseInt(String(req.query.limit ?? '20'), 10);
  if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
  }

  try {
    const rows = await listRecentCsatResponses(tenantId, parsedLimit);
    // Map to a UI-friendly shape — drop internals like dispatch_token /
    // raw response body that the settings page has no business rendering.
    const responses = rows.map((r) => ({
      id: r.id,
      callSessionId: r.callSessionId,
      requestChannel: r.requestChannel,
      responseChannel: r.responseChannel,
      scoreRaw: r.scoreRaw,
      scoreScale: r.scoreScale,
      scoreNormalized: r.scoreNormalized,
      comment: r.comment,
      respondedAt: r.respondedAt,
    }));
    return res.json({ responses });
  } catch (err) {
    logger.error('Failed to list recent CSAT responses', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list recent CSAT responses' });
  }
});

export default router;
