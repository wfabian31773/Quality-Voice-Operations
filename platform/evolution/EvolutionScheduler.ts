import { createLogger } from '../core/logger';
import { runSignalCollection } from './SignalCollector';
import { runOpportunityDetection } from './OpportunityDetectionEngine';
import { generateRoadmapRecommendations } from './RoadmapRecommendationEngine';

const logger = createLogger('EVOLUTION_SCHEDULER');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

async function runFullPipeline(): Promise<{ signals: number; opportunities: number; recommendations: number }> {
  if (isRunning) {
    logger.warn('Evolution pipeline already running, skipping');
    return { signals: 0, opportunities: 0, recommendations: 0 };
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    logger.info('Evolution pipeline started');

    const signals = await runSignalCollection();
    logger.info('Signal collection phase complete', { signals });

    const opportunities = await runOpportunityDetection();
    logger.info('Opportunity detection phase complete', { opportunities });

    const recommendations = await generateRoadmapRecommendations();
    logger.info('Recommendation generation phase complete', { recommendations });

    const durationMs = Date.now() - startTime;
    logger.info('Evolution pipeline completed', { signals, opportunities, recommendations, durationMs });

    return { signals, opportunities, recommendations };
  } catch (err) {
    logger.error('Evolution pipeline failed', { error: String(err), durationMs: Date.now() - startTime });
    throw err;
  } finally {
    isRunning = false;
  }
}

export function startEvolutionScheduler(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (schedulerTimer) {
    logger.warn('Evolution scheduler already running');
    return;
  }

  logger.info('Starting evolution scheduler', { intervalMs, intervalHours: intervalMs / 3600000 });

  schedulerTimer = setInterval(async () => {
    try {
      await runFullPipeline();
    } catch (err) {
      logger.error('Scheduled evolution pipeline run failed', { error: String(err) });
    }
  }, intervalMs);

  setTimeout(async () => {
    try {
      await runFullPipeline();
    } catch (err) {
      logger.error('Initial evolution pipeline run failed', { error: String(err) });
    }
  }, 30_000);
}

export function stopEvolutionScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info('Evolution scheduler stopped');
  }
}

export function isSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}

export function isPipelineRunning(): boolean {
  return isRunning;
}

export { runFullPipeline };
