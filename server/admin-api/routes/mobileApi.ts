import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireApiKeyOrJwt } from '../middleware/apiKeyAuth';
import { requireApiKeyPermission } from '../middleware/apiKeyScope';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import {
  listJobsHandler,
  getJobHandler,
  transitionJobHandler,
  listResourcesHandler,
} from './dispatch';
import {
  listBookingsHandler,
  getBookingHandler,
  transitionBookingHandler,
} from './scheduling';

const router = Router();

const apiKeyAuth = requireApiKeyOrJwt(requireAuth);

/**
 * Write-auth for mobile-mounted endpoints.
 *
 * - API-key callers must have a `write` (or higher) scope on the key.
 * - JWT-authenticated callers must satisfy `requireMiniSystemWrite`
 *   (tenant_owner / operations_manager), matching the original guard on the
 *   canonical `/dispatch/*` and `/scheduling/*` routes.
 *
 * This is necessary because `requireApiKeyPermission` is a no-op for non
 * API-key users, so on its own it would let any authenticated session bypass
 * the role check.
 */
const requireMobileWrite = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const isApiKey = req.user.userId.startsWith('apikey:');
  if (isApiKey) {
    requireApiKeyPermission('write')(req, res, next);
    return;
  }
  requireMiniSystemWrite(req, res, next);
};

const mobileLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 240,
  message: 'Mobile API rate limit exceeded. Please try again later.',
  keyGenerator: (req) => {
    const userId = req.user?.userId ?? 'anon';
    const tenantId = req.user?.tenantId ?? 'unknown';
    return `mobile-api:${tenantId}:${userId}`;
  },
});

// ── Dispatch (technician-facing) ──
router.get(
  '/api/v1/dispatch/resources',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  listResourcesHandler,
);
router.get(
  '/api/v1/dispatch/jobs',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  listJobsHandler,
);
router.get(
  '/api/v1/dispatch/jobs/:id',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  getJobHandler,
);
router.post(
  '/api/v1/dispatch/jobs/:id/transition',
  apiKeyAuth,
  mobileLimiter,
  requireMobileWrite,
  transitionJobHandler,
);

// ── Scheduling (technician-facing) ──
router.get(
  '/api/v1/scheduling/bookings',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  listBookingsHandler,
);
router.get(
  '/api/v1/scheduling/bookings/:id',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  getBookingHandler,
);
router.post(
  '/api/v1/scheduling/bookings/:id/transition',
  apiKeyAuth,
  mobileLimiter,
  requireMobileWrite,
  transitionBookingHandler,
);

export default router;
