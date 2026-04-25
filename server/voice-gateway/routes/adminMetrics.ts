import { Router, type Request, type Response, type NextFunction } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { getTwilioSignatureMetrics } from '../middleware/twilioSignatureMetrics';

const router = Router();
const logger = createLogger('ADMIN_METRICS');

function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.ADMIN_INTERNAL_TOKEN;

  if (!adminToken) {
    logger.error('ADMIN_INTERNAL_TOKEN not configured — rejecting admin request');
    res.status(503).json({ error: 'Admin endpoint not available: missing server configuration' });
    return;
  }

  const provided = req.headers['x-admin-token'];
  if (provided !== adminToken) {
    logger.warn('Admin metrics request rejected: invalid token', { ip: req.ip });
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  next();
}

router.get('/admin/twilio-webhook-security', requireAdminToken, (_req, res) => {
  try {
    const snapshot = getTwilioSignatureMetrics();
    return res.json(snapshot);
  } catch (err) {
    logger.error('Failed to read twilio signature metrics', { error: String(err) });
    return res.status(500).json({ error: 'Failed to read metrics' });
  }
});

export default router;
