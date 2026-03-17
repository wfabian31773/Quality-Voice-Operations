import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireApiKeyOrJwt } from '../middleware/apiKeyAuth';
import { requireRole } from '../middleware/rbac';
import { requireApiKeyPermission } from '../middleware/apiKeyScope';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import { listCallsHandler, getCallHandler } from './calls';
import { listCampaignsHandler, getCampaignMetricsHandler, addContactsHandler } from './campaigns';

const router = Router();

const apiKeyAuth = requireApiKeyOrJwt(requireAuth);

const publicApiLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 100,
  message: 'API rate limit exceeded. Please try again later.',
  keyGenerator: (req) => {
    const userId = req.user?.userId ?? 'anon';
    const tenantId = req.user?.tenantId ?? 'unknown';
    return `public-api:${tenantId}:${userId}`;
  },
});

router.get('/api/v1/calls', apiKeyAuth, publicApiLimiter, requireApiKeyPermission('read-only'), listCallsHandler);
router.get('/api/v1/calls/:id', apiKeyAuth, publicApiLimiter, requireApiKeyPermission('read-only'), getCallHandler);
router.get('/api/v1/campaigns', apiKeyAuth, publicApiLimiter, requireApiKeyPermission('read-only'), listCampaignsHandler);
router.get('/api/v1/campaigns/:id/analytics', apiKeyAuth, publicApiLimiter, requireApiKeyPermission('read-only'), getCampaignMetricsHandler);
router.post('/api/v1/campaigns/:id/contacts', apiKeyAuth, publicApiLimiter, requireApiKeyPermission('write'), requireRole('admin'), addContactsHandler);

export default router;
