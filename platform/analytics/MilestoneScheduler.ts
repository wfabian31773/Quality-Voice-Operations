import { createLogger } from '../core/logger';
import { checkAllTenantMilestones } from './CaseStudyService';

const logger = createLogger('MILESTONE_SCHEDULER');

let milestoneTimer: ReturnType<typeof setInterval> | null = null;

const MILESTONE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runMilestoneCheckCycle(): Promise<void> {
  try {
    logger.info('Starting automated milestone check cycle');
    const results = await checkAllTenantMilestones();
    const totalGenerated = results.reduce((sum, r) => sum + r.generated, 0);
    if (totalGenerated > 0) {
      logger.info('Milestone check generated new case studies', { totalGenerated, tenants: results.length });
    }
  } catch (err) {
    logger.error('Milestone check cycle error', { error: String(err) });
  }
}

export function startMilestoneScheduler(): void {
  if (milestoneTimer) return;

  setTimeout(() => runMilestoneCheckCycle(), 60 * 1000);

  milestoneTimer = setInterval(runMilestoneCheckCycle, MILESTONE_CHECK_INTERVAL_MS);
  logger.info('Milestone scheduler started', { intervalMs: MILESTONE_CHECK_INTERVAL_MS });
}

export function stopMilestoneScheduler(): void {
  if (milestoneTimer) {
    clearInterval(milestoneTimer);
    milestoneTimer = null;
    logger.info('Milestone scheduler stopped');
  }
}
