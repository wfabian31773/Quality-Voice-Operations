/**
 * Codex #90 P2: first-run setTimeouts on insights / workforce / GIN /
 * milestones must be stored and cleared on stop, otherwise a worker that
 * loses leadership (or shuts down) still fires the cycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  detectAnomalies,
  runInsightsAnalysis,
  generateWeeklyReport,
  measureInsightImpact,
  runAnalysis,
  calculateMetrics,
  runAggregationPipeline,
  checkAllTenantMilestones,
  poolQuery,
} = vi.hoisted(() => ({
  detectAnomalies: vi.fn(async () => {}),
  runInsightsAnalysis: vi.fn(async () => {}),
  generateWeeklyReport: vi.fn(async () => {}),
  measureInsightImpact: vi.fn(async () => {}),
  runAnalysis: vi.fn(async () => {}),
  calculateMetrics: vi.fn(async () => {}),
  runAggregationPipeline: vi.fn(async () => ({ status: 'completed', signalsCollected: 0, runId: 'r1' })),
  checkAllTenantMilestones: vi.fn(async () => []),
  poolQuery: vi.fn(async () => ({ rows: [{ id: 't1', tenant_id: 't1', team_id: 'team-1' }] })),
}));

vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getPrivilegedPool: () => ({ query: poolQuery }),
}));

vi.mock('../analytics/InsightsEngine', () => ({
  detectAnomalies,
  runInsightsAnalysis,
  generateWeeklyReport,
  measureInsightImpact,
}));

vi.mock('../workforce/WorkforceOptimizationEngine', () => ({
  WorkforceOptimizationEngine: class {
    runAnalysis = runAnalysis;
  },
}));

vi.mock('../workforce/WorkforceRevenueService', () => ({
  WorkforceRevenueService: class {
    calculateMetrics = calculateMetrics;
  },
}));

vi.mock('../gin/AggregationPipeline', () => ({ runAggregationPipeline }));
vi.mock('../gin/GlobalInsightEngine', () => ({ runGlobalPatternDetection: vi.fn() }));
vi.mock('../gin/RecommendationDistributor', () => ({ distributeRecommendations: vi.fn() }));
vi.mock('../gin/publicBenchmarkCache', () => ({ invalidatePublicBenchmarkCache: vi.fn() }));
vi.mock('../analytics/CaseStudyService', () => ({ checkAllTenantMilestones }));

import { startInsightsScheduler, stopInsightsScheduler } from '../analytics/InsightsScheduler';
import { startWorkforceScheduler, stopWorkforceScheduler } from '../workforce/WorkforceScheduler';
import { startGinScheduler, stopGinScheduler } from '../gin/GinScheduler';
import { startMilestoneScheduler, stopMilestoneScheduler } from '../analytics/MilestoneScheduler';

beforeEach(() => {
  vi.useFakeTimers();
  detectAnomalies.mockClear();
  runAnalysis.mockClear();
  runAggregationPipeline.mockClear();
  checkAllTenantMilestones.mockClear();
  poolQuery.mockClear();
});

afterEach(() => {
  stopInsightsScheduler();
  stopWorkforceScheduler();
  stopGinScheduler();
  stopMilestoneScheduler();
  vi.useRealTimers();
});

describe('deferred scheduler first-runs', () => {
  it('insights: stop cancels the 60 s first-run; a later start fires it exactly once', async () => {
    startInsightsScheduler();
    stopInsightsScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(detectAnomalies).not.toHaveBeenCalled();

    startInsightsScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(detectAnomalies).toHaveBeenCalledTimes(1);

    stopInsightsScheduler();
    startInsightsScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(detectAnomalies).toHaveBeenCalledTimes(2);
  });

  it('workforce: stop cancels the 120 s first-run', async () => {
    startWorkforceScheduler();
    stopWorkforceScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runAnalysis).not.toHaveBeenCalled();

    startWorkforceScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runAnalysis).toHaveBeenCalledTimes(1);
  });

  it('GIN: stop cancels the 5 min first-run', async () => {
    startGinScheduler();
    stopGinScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(runAggregationPipeline).not.toHaveBeenCalled();

    startGinScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(runAggregationPipeline).toHaveBeenCalledTimes(1);
  });

  it('milestones: stop cancels the 60 s first-run; start is idempotent', async () => {
    startMilestoneScheduler();
    startMilestoneScheduler();
    stopMilestoneScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkAllTenantMilestones).not.toHaveBeenCalled();

    startMilestoneScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkAllTenantMilestones).toHaveBeenCalledTimes(1);
  });
});
