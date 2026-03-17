import { createLogger } from '../core/logger';
import { runAggregationPipeline } from './AggregationPipeline';
import { runGlobalPatternDetection } from './GlobalInsightEngine';
import { distributeRecommendations } from './RecommendationDistributor';

const logger = createLogger('GIN_SCHEDULER');

let aggregationTimer: ReturnType<typeof setInterval> | null = null;

const AGGREGATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runGinCycle(): Promise<void> {
  try {
    logger.info('Starting GIN aggregation cycle');

    const result = await runAggregationPipeline();
    if (result.status !== 'completed' || result.signalsCollected < 3) {
      logger.info('Aggregation produced insufficient data, skipping pattern detection', { result });
      return;
    }

    await runGlobalPatternDetection(result.runId);
    await distributeRecommendations();

    logger.info('GIN cycle complete', { runId: result.runId });
  } catch (err) {
    logger.error('GIN cycle error', { error: String(err) });
  }
}

export function startGinScheduler(): void {
  logger.info('Starting GIN scheduler', { intervalHours: AGGREGATION_INTERVAL_MS / 3600000 });

  setTimeout(() => runGinCycle(), 5 * 60 * 1000);

  aggregationTimer = setInterval(runGinCycle, AGGREGATION_INTERVAL_MS);
}

export function stopGinScheduler(): void {
  if (aggregationTimer) {
    clearInterval(aggregationTimer);
    aggregationTimer = null;
  }
  logger.info('GIN scheduler stopped');
}
