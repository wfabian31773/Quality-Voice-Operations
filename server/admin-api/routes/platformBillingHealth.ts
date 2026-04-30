import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { verifyStripePrices } from '../../../platform/billing/stripe/verifyPrices';
import {
  getLatestStripePriceVerificationSnapshot,
  type StripePriceVerificationSnapshot,
} from '../../../platform/billing/StripePriceVerificationScheduler';

const router = Router();
const logger = createLogger('PLATFORM_BILLING_HEALTH');

router.get(
  '/platform/billing-config-health',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const report = await verifyStripePrices();
      const lastScheduledRun: StripePriceVerificationSnapshot | null =
        getLatestStripePriceVerificationSnapshot();
      res.json({ ...report, lastScheduledRun });
    } catch (err) {
      logger.error('Failed to verify Stripe price config', {
        error: String(err),
      });
      res.status(500).json({ error: 'Failed to verify Stripe price config' });
    }
  },
);

export default router;
