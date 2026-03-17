import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';
import { WorkforceOptimizationEngine } from './WorkforceOptimizationEngine';
import { WorkforceRevenueService } from './WorkforceRevenueService';

const logger = createLogger('WORKFORCE_SCHEDULER');

const optimizationEngine = new WorkforceOptimizationEngine();
const revenueService = new WorkforceRevenueService();

let optimizationTimer: ReturnType<typeof setInterval> | null = null;
let revenueTimer: ReturnType<typeof setInterval> | null = null;

const OPTIMIZATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REVENUE_INTERVAL_MS = 4 * 60 * 60 * 1000;

async function getActiveTenantTeams(): Promise<Array<{ tenantId: string; teamId: string }>> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT DISTINCT t.tenant_id, t.id as team_id
     FROM workforce_teams t
     WHERE t.status = 'active'
     LIMIT 500`,
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id as string,
    teamId: r.team_id as string,
  }));
}

async function runOptimizationCycle(): Promise<void> {
  try {
    const teams = await getActiveTenantTeams();
    logger.info('Starting workforce optimization cycle', { teamCount: teams.length });

    for (const { tenantId, teamId } of teams) {
      try {
        await optimizationEngine.runAnalysis(tenantId, teamId);
      } catch (err) {
        logger.error('Workforce optimization failed for team', { tenantId, teamId, error: String(err) });
      }
    }

    logger.info('Workforce optimization cycle complete', { teamsProcessed: teams.length });
  } catch (err) {
    logger.error('Workforce optimization cycle error', { error: String(err) });
  }
}

async function runRevenueCycle(): Promise<void> {
  try {
    const teams = await getActiveTenantTeams();
    logger.info('Starting workforce revenue calculation cycle', { teamCount: teams.length });

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    for (const { tenantId, teamId } of teams) {
      try {
        await revenueService.calculateMetrics(tenantId, teamId, sevenDaysAgo, now);
      } catch (err) {
        logger.error('Workforce revenue calculation failed for team', { tenantId, teamId, error: String(err) });
      }
    }

    logger.info('Workforce revenue cycle complete', { teamsProcessed: teams.length });
  } catch (err) {
    logger.error('Workforce revenue cycle error', { error: String(err) });
  }
}

export function startWorkforceScheduler(): void {
  logger.info('Starting workforce scheduler', {
    optimizationIntervalMs: OPTIMIZATION_INTERVAL_MS,
    revenueIntervalMs: REVENUE_INTERVAL_MS,
  });

  setTimeout(() => {
    runOptimizationCycle().catch((err) => {
      logger.error('Initial workforce optimization cycle failed', { error: String(err) });
    });
  }, 120_000);

  optimizationTimer = setInterval(() => {
    runOptimizationCycle().catch((err) => {
      logger.error('Workforce optimization cycle failed', { error: String(err) });
    });
  }, OPTIMIZATION_INTERVAL_MS);

  revenueTimer = setInterval(() => {
    runRevenueCycle().catch((err) => {
      logger.error('Workforce revenue cycle failed', { error: String(err) });
    });
  }, REVENUE_INTERVAL_MS);
}

export function stopWorkforceScheduler(): void {
  if (optimizationTimer) {
    clearInterval(optimizationTimer);
    optimizationTimer = null;
  }
  if (revenueTimer) {
    clearInterval(revenueTimer);
    revenueTimer = null;
  }
  logger.info('Workforce scheduler stopped');
}
