import { getPrivilegedPool } from '../db';
import { createLogger } from '../core/logger';
import { runInsightsAnalysis, detectAnomalies, generateWeeklyReport, measureInsightImpact } from './InsightsEngine';

const logger = createLogger('INSIGHTS_SCHEDULER');

let anomalyTimer: ReturnType<typeof setInterval> | null = null;
let analysisTimer: ReturnType<typeof setInterval> | null = null;
let weeklyTimer: ReturnType<typeof setInterval> | null = null;
let impactTimer: ReturnType<typeof setInterval> | null = null;
let initialAnomalyTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped on start/stop so a deferred first-run cannot fire after leadership loss. */
let insightsGeneration = 0;

const ANOMALY_INTERVAL_MS = 30 * 60 * 1000;
const ANALYSIS_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WEEKLY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IMPACT_MEASUREMENT_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function getActiveTenantIds(): Promise<string[]> {
  const pool = getPrivilegedPool();
  const { rows } = await pool.query(
    `SELECT DISTINCT id FROM tenants WHERE status = 'active' LIMIT 100`,
  );
  return rows.map((r) => r.id as string);
}

async function runAnomalyDetectionCycle(): Promise<void> {
  try {
    const tenantIds = await getActiveTenantIds();
    logger.info('Starting anomaly detection cycle', { tenantCount: tenantIds.length });

    for (const tenantId of tenantIds) {
      try {
        await detectAnomalies(tenantId);
      } catch (err) {
        logger.error('Anomaly detection failed for tenant', { tenantId, error: String(err) });
      }
    }

    logger.info('Anomaly detection cycle complete');
  } catch (err) {
    logger.error('Anomaly detection cycle error', { error: String(err) });
  }
}

async function runInsightsAnalysisCycle(): Promise<void> {
  try {
    const tenantIds = await getActiveTenantIds();
    logger.info('Starting insights analysis cycle', { tenantCount: tenantIds.length });

    for (const tenantId of tenantIds) {
      try {
        await runInsightsAnalysis(tenantId);
      } catch (err) {
        logger.error('Insights analysis failed for tenant', { tenantId, error: String(err) });
      }
    }

    logger.info('Insights analysis cycle complete');
  } catch (err) {
    logger.error('Insights analysis cycle error', { error: String(err) });
  }
}

async function runWeeklyReportCycle(): Promise<void> {
  try {
    const now = new Date();
    if (now.getUTCDay() !== 0) {
      return;
    }

    const tenantIds = await getActiveTenantIds();
    logger.info('Starting weekly report generation cycle', { tenantCount: tenantIds.length });

    for (const tenantId of tenantIds) {
      try {
        await generateWeeklyReport(tenantId);
      } catch (err) {
        logger.error('Weekly report generation failed for tenant', { tenantId, error: String(err) });
      }
    }

    logger.info('Weekly report generation cycle complete');
  } catch (err) {
    logger.error('Weekly report cycle error', { error: String(err) });
  }
}

async function runImpactMeasurementCycle(): Promise<void> {
  try {
    const tenantIds = await getActiveTenantIds();
    logger.info('Starting impact measurement cycle', { tenantCount: tenantIds.length });

    for (const tenantId of tenantIds) {
      try {
        await measureInsightImpact(tenantId);
      } catch (err) {
        logger.error('Impact measurement failed for tenant', { tenantId, error: String(err) });
      }
    }

    logger.info('Impact measurement cycle complete');
  } catch (err) {
    logger.error('Impact measurement cycle error', { error: String(err) });
  }
}

export function startInsightsScheduler(): void {
  if (anomalyTimer) return;
  const generation = ++insightsGeneration;
  logger.info('Starting insights scheduler', {
    anomalyIntervalMin: ANOMALY_INTERVAL_MS / 60000,
    analysisIntervalHr: ANALYSIS_INTERVAL_MS / 3600000,
    weeklyCheckIntervalHr: WEEKLY_CHECK_INTERVAL_MS / 3600000,
  });

  initialAnomalyTimer = setTimeout(() => {
    initialAnomalyTimer = null;
    if (insightsGeneration !== generation) return;
    void runAnomalyDetectionCycle();
  }, 60_000);

  anomalyTimer = setInterval(() => {
    if (insightsGeneration !== generation) return;
    void runAnomalyDetectionCycle();
  }, ANOMALY_INTERVAL_MS);
  analysisTimer = setInterval(() => {
    if (insightsGeneration !== generation) return;
    void runInsightsAnalysisCycle();
  }, ANALYSIS_INTERVAL_MS);
  weeklyTimer = setInterval(() => {
    if (insightsGeneration !== generation) return;
    void runWeeklyReportCycle();
  }, WEEKLY_CHECK_INTERVAL_MS);
  impactTimer = setInterval(() => {
    if (insightsGeneration !== generation) return;
    void runImpactMeasurementCycle();
  }, IMPACT_MEASUREMENT_INTERVAL_MS);
}

export function stopInsightsScheduler(): void {
  insightsGeneration += 1;
  if (initialAnomalyTimer) {
    clearTimeout(initialAnomalyTimer);
    initialAnomalyTimer = null;
  }
  if (anomalyTimer) {
    clearInterval(anomalyTimer);
    anomalyTimer = null;
  }
  if (analysisTimer) {
    clearInterval(analysisTimer);
    analysisTimer = null;
  }
  if (weeklyTimer) {
    clearInterval(weeklyTimer);
    weeklyTimer = null;
  }
  if (impactTimer) {
    clearInterval(impactTimer);
    impactTimer = null;
  }
  logger.info('Insights scheduler stopped');
}
