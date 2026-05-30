import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { runReconciliationCycle } from '../../../platform/billing/BillingReconciliationScheduler';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('PLATFORM_BILLING_RECONCILIATION_ROUTE');

const router = Router();

/**
 * Manual trigger for the cost-reconciliation cycle (audit fix #5).
 *
 * The daily cron runs at the configured `BILLING_RECONCILIATION_INTERVAL_MS`
 * cadence; this endpoint exists for the "I just landed a late Stripe
 * payment and want to see the row update now" workflow, and for
 * debugging during rollout.
 *
 * Returns the same summary the cron logs internally:
 *   { tenantsProcessed, monthsProcessed, rowsUpserted, alertsSent,
 *     errors, durationMs, bootstrap }
 *
 * Cycle-in-flight guard: if the cron is mid-run, this returns a
 * zero-row summary rather than double-processing.
 */
router.post(
  '/platform/billing/reconciliation/run',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const summary = await runReconciliationCycle('manual');
      res.json({ ok: true, summary });
    } catch (err) {
      logger.error('Manual reconciliation run failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ ok: false, error: 'reconciliation_failed' });
    }
  },
);

export default router;
