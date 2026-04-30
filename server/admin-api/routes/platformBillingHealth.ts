import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { verifyStripePrices } from '../../../platform/billing/stripe/verifyPrices';

const router = Router();
const logger = createLogger('PLATFORM_BILLING_HEALTH');

/**
 * Billing config health.
 *
 * Re-runs the same `STRIPE_PRICE_<TIER>_<INTERVAL>` verification that
 * `scripts/verify-stripe-prices.ts` runs in the deploy build (see
 * `.replit` `[deployment].build`), but on demand against the *currently
 * running* Admin API process — so platform admins can spot a typoed price
 * id, a wrong-interval wiring, or a deleted Stripe price without having
 * to redeploy. The deploy gate is still the primary line of defence;
 * this endpoint is the "re-run after rotating a price id" escape hatch
 * that the live-rate badge regression playbook calls out.
 */
router.get(
  '/platform/billing-config-health',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const report = await verifyStripePrices();
      res.json(report);
    } catch (err) {
      logger.error('Failed to verify Stripe price config', {
        error: String(err),
      });
      res.status(500).json({ error: 'Failed to verify Stripe price config' });
    }
  },
);

export default router;
