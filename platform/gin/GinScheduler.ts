import { createLogger } from '../core/logger';
import { runAggregationPipeline } from './AggregationPipeline';
import { runGlobalPatternDetection } from './GlobalInsightEngine';
import { distributeRecommendations } from './RecommendationDistributor';
import { invalidatePublicBenchmarkCache } from './publicBenchmarkCache';

const logger = createLogger('GIN_SCHEDULER');

let aggregationTimer: ReturnType<typeof setInterval> | null = null;
let initialAggregationTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped on start/stop so a deferred first-run cannot fire after leadership loss. */
let ginGeneration = 0;

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

    // New aggregation data is available — bust the cached marketing snapshot
    // so the next public request picks it up instead of waiting for TTL.
    await invalidatePublicBenchmarkCache();

    logger.info('GIN cycle complete', { runId: result.runId });
  } catch (err) {
    logger.error('GIN cycle error', { error: String(err) });
  }
}

export function startGinScheduler(): void {
  if (aggregationTimer) return;
  const generation = ++ginGeneration;
  logger.info('Starting GIN scheduler', { intervalHours: AGGREGATION_INTERVAL_MS / 3600000 });

  initialAggregationTimer = setTimeout(() => {
    initialAggregationTimer = null;
    if (ginGeneration !== generation) return;
    void runGinCycle();
  }, 5 * 60 * 1000);

  aggregationTimer = setInterval(() => {
    if (ginGeneration !== generation) return;
    void runGinCycle();
  }, AGGREGATION_INTERVAL_MS);
}

export function stopGinScheduler(): void {
  ginGeneration += 1;
  if (initialAggregationTimer) {
    clearTimeout(initialAggregationTimer);
    initialAggregationTimer = null;
  }
  if (aggregationTimer) {
    clearInterval(aggregationTimer);
    aggregationTimer = null;
  }
  logger.info('GIN scheduler stopped');
}
