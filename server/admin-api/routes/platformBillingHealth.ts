import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { verifyStripePrices } from '../../../platform/billing/stripe/verifyPrices';
import {
  getLatestStripePriceVerificationSnapshot,
  type StripePriceVerificationSnapshot,
} from '../../../platform/billing/StripePriceVerificationScheduler';
import {
  getLatestSuccessScreenshot,
  getLiveBillingHealthSummary,
} from '../../../platform/billing/githubLiveBillingHealthArtifact';

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

// Metadata for the most recent live billing-health screenshot. Sourced
// from the `billing-health-live-stripe.yml` workflow's artifact via the
// GitHub API (cached in-process). The Platform Admin "Billing config
// health" panel uses this to surface a thumbnail of the last green run
// + a red dot / tracking-issue link when the latest run failed, so ops
// no longer has to dig through Actions.
router.get(
  '/platform/billing-config-health/last-live-run',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const summary = await getLiveBillingHealthSummary({ forceRefresh });
      res.json(summary);
    } catch (err) {
      logger.error('Failed to load live billing-health summary', { error: String(err) });
      res.status(500).json({ error: 'Failed to load live billing-health summary' });
    }
  },
);

// Streams the PNG screenshot from the most recent successful live
// billing-health workflow run. Returns 404 when the integration isn't
// configured or no green run has produced an artifact yet — the panel
// hides the thumbnail in that case.
router.get(
  '/platform/billing-config-health/last-live-screenshot.png',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const screenshot = await getLatestSuccessScreenshot();
      if (!screenshot) {
        res.status(404).json({ error: 'No live billing-health screenshot available' });
        return;
      }
      res.setHeader('Content-Type', screenshot.contentType);
      res.setHeader('Content-Length', String(screenshot.buffer.byteLength));
      // Cache moderately on the client — the upstream snapshot itself
      // is cached in-process for ~5 minutes, so a matching browser
      // cache window keeps the panel snappy on tab switches without
      // pinning a stale image past the next nightly run.
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.end(screenshot.buffer);
    } catch (err) {
      logger.error('Failed to stream live billing-health screenshot', {
        error: String(err),
      });
      res.status(500).json({ error: 'Failed to stream live billing-health screenshot' });
    }
  },
);

export default router;
