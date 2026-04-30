/**
 * Platform Admin endpoint for the Stripe billing-portal configuration
 * cleanup sweep (PortalConfigCleanupScheduler).
 *
 *   GET  /platform/portal-config-cleanup       — return the latest snapshot
 *   POST /platform/portal-config-cleanup/run   — trigger a manual cycle
 *
 * The manual run is synchronous and returns the resulting snapshot so a
 * platform admin clicking "Run cleanup now" sees the deactivation
 * counts immediately. The underlying cycle is safe to invoke
 * concurrently with the daily scheduled run; Stripe accepts a redundant
 * `configurations.update({ active: false })` against an already-inactive
 * id as a no-op.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  PORTAL_CONFIG_CLEANUP_DEFAULTS,
  getLatestPortalConfigCleanupSnapshot,
  runPortalConfigCleanupCycle,
} from '../../../platform/billing/PortalConfigCleanupScheduler';

const router = Router();
const logger = createLogger('PLATFORM_PORTAL_CONFIG_CLEANUP');

router.get(
  '/platform/portal-config-cleanup',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const snapshot = getLatestPortalConfigCleanupSnapshot();
      res.json({
        intervalMs: PORTAL_CONFIG_CLEANUP_DEFAULTS.intervalMs,
        lastRun: snapshot,
      });
    } catch (err) {
      logger.error('Failed to load portal-config cleanup snapshot', {
        error: String(err),
      });
      res
        .status(500)
        .json({ error: 'Failed to load portal-config cleanup snapshot' });
    }
  },
);

router.post(
  '/platform/portal-config-cleanup/run',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const snapshot = await runPortalConfigCleanupCycle({ source: 'manual' });
      res.json({
        intervalMs: PORTAL_CONFIG_CLEANUP_DEFAULTS.intervalMs,
        lastRun: snapshot,
      });
    } catch (err) {
      // `runPortalConfigCleanupCycle` already returns a failure snapshot
      // for individual-cycle errors; this catch only fires if the
      // snapshot bookkeeping itself throws, which would be exceptional.
      logger.error('Failed to run portal-config cleanup cycle', {
        error: String(err),
      });
      res
        .status(500)
        .json({ error: 'Failed to run portal-config cleanup cycle' });
    }
  },
);

export default router;
