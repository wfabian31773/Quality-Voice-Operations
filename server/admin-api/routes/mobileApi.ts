import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireApiKeyOrJwt } from '../middleware/apiKeyAuth';
import { requireApiKeyPermission } from '../middleware/apiKeyScope';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import {
  listJobsHandler,
  getJobHandler,
  transitionJobHandler,
  listResourcesHandler,
  addAttachmentHandler,
  requestAttachmentUploadUrlHandler,
  getAttachmentFileHandler,
} from './dispatch';
import {
  listBookingsHandler,
  getBookingHandler,
  transitionBookingHandler,
} from './scheduling';

const logger = createLogger('MOBILE_API');

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
router.post(
  '/api/v1/dispatch/uploads/request-url',
  apiKeyAuth,
  mobileLimiter,
  requireMobileWrite,
  requestAttachmentUploadUrlHandler,
);
router.post(
  '/api/v1/dispatch/jobs/:id/attachments',
  apiKeyAuth,
  mobileLimiter,
  requireMobileWrite,
  addAttachmentHandler,
);
router.get(
  '/api/v1/dispatch/attachments/:attachmentId/file',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  getAttachmentFileHandler,
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

// ── Push device registration ──────────────────────────────────────────
//
// The technician app calls these to register / unregister its Expo push
// token, and to flip the per-device "Notifications" switch in the Profile
// tab. They run under the same API-key-or-JWT auth as the read endpoints
// (read-only is sufficient — registering a token is a self-write that
// only affects which device receives pushes for the current tenant).

const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

function normalizeOptionalString(value: unknown, max = 255): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

const registerDeviceHandler = async (req: Request, res: Response): Promise<void> => {
  const { tenantId, userId } = req.user!;
  const isApiKey = userId.startsWith('apikey:');
  const realUserId = isApiKey ? null : userId;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  if (!EXPO_TOKEN_RE.test(token)) {
    res.status(400).json({ error: 'token must be an Expo push token' });
    return;
  }

  const resourceId = typeof body.resource_id === 'string' && body.resource_id ? body.resource_id : null;
  const platform = ((): string => {
    const v = typeof body.platform === 'string' ? body.platform.toLowerCase() : 'expo';
    return v === 'expo' || v === 'ios' || v === 'android' || v === 'web' ? v : 'expo';
  })();
  const deviceLabel = normalizeOptionalString(body.device_label, 120);
  const appVersion = normalizeOptionalString(body.app_version, 64);
  const pushEnabled = body.push_enabled === undefined ? true : body.push_enabled !== false;

  const pool = getPlatformPool();
  try {
    if (resourceId) {
      const { rows: rcheck } = await pool.query(
        `SELECT id FROM dispatch_resources WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [resourceId, tenantId],
      );
      if (rcheck.length === 0) {
        res.status(400).json({ error: 'resource_id does not belong to this tenant' });
        return;
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO user_devices (
         tenant_id, resource_id, user_id, push_token, platform,
         push_enabled, device_label, app_version, last_seen_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (tenant_id, push_token)
       DO UPDATE SET
         resource_id  = EXCLUDED.resource_id,
         user_id      = COALESCE(EXCLUDED.user_id, user_devices.user_id),
         platform     = EXCLUDED.platform,
         push_enabled = EXCLUDED.push_enabled,
         device_label = EXCLUDED.device_label,
         app_version  = EXCLUDED.app_version,
         last_seen_at = NOW(),
         updated_at   = NOW()
       RETURNING id, tenant_id, resource_id, user_id, push_token, platform,
                 push_enabled, device_label, app_version, last_seen_at`,
      [tenantId, resourceId, realUserId, token, platform, pushEnabled, deviceLabel, appVersion],
    );
    res.status(200).json({ device: rows[0] });
  } catch (err) {
    logger.error('Failed to register push device', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to register device' });
  }
};

const updateDeviceHandler = async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req.user!;
  const token = req.params.token;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  const updates: string[] = ['updated_at = NOW()', 'last_seen_at = NOW()'];
  const values: unknown[] = [];
  let idx = 1;
  if (typeof body.push_enabled === 'boolean') {
    updates.push(`push_enabled = $${idx++}`);
    values.push(body.push_enabled);
  }
  if (typeof body.resource_id === 'string' || body.resource_id === null) {
    updates.push(`resource_id = $${idx++}`);
    values.push(body.resource_id || null);
  }
  if (typeof body.device_label === 'string') {
    updates.push(`device_label = $${idx++}`);
    values.push(normalizeOptionalString(body.device_label, 120));
  }
  if (typeof body.app_version === 'string') {
    updates.push(`app_version = $${idx++}`);
    values.push(normalizeOptionalString(body.app_version, 64));
  }

  if (values.length === 0) {
    res.status(400).json({ error: 'No updatable fields provided' });
    return;
  }

  values.push(token, tenantId);
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE user_devices
          SET ${updates.join(', ')}
        WHERE push_token = $${idx++} AND tenant_id = $${idx}
        RETURNING id, tenant_id, resource_id, user_id, push_token, platform,
                  push_enabled, device_label, app_version, last_seen_at`,
      values,
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    res.json({ device: rows[0] });
  } catch (err) {
    logger.error('Failed to update push device', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to update device' });
  }
};

const deleteDeviceHandler = async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req.user!;
  const token = req.params.token;
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM user_devices WHERE push_token = $1 AND tenant_id = $2`,
      [token, tenantId],
    );
    res.json({ success: true, removed: rowCount ?? 0 });
  } catch (err) {
    logger.error('Failed to delete push device', { tenantId, error: String(err) });
    res.status(500).json({ error: 'Failed to delete device' });
  }
};

router.post(
  '/api/v1/mobile/devices',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  registerDeviceHandler,
);
router.patch(
  '/api/v1/mobile/devices/:token',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  updateDeviceHandler,
);
router.delete(
  '/api/v1/mobile/devices/:token',
  apiKeyAuth,
  mobileLimiter,
  requireApiKeyPermission('read-only'),
  deleteDeviceHandler,
);

export default router;
