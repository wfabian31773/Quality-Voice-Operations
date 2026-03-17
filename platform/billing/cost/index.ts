export {
  recordConversationCost,
  getConversationCost,
  getConversationCostRunningTotal,
  type ConversationCostRecord,
  type RecordCostParams,
} from './CostTrackingService';

export {
  routeQuery,
  classifyComplexity,
  routeToTier,
  logRoutingDecision,
  getRoutingDistribution,
  type RoutingDecision,
} from './ModelRouter';

export {
  getCachedResponse,
  setCachedResponse,
  getCacheStats,
  cleanExpiredCache,
  type CachedResponse,
} from './ResponseCache';

export {
  compressConversation,
  shouldCompress,
  type ConversationMessage,
  type CompressionResult,
} from './TokenCompressor';

export {
  getCostBudgetSettings,
  upsertCostBudgetSettings,
  checkConversationBudget,
  type CostBudgetSettings,
  type BudgetCheckResult,
} from './CostBudgetService';

export {
  getCostOptimizationAnalytics,
  getConversationCosts,
  type CostAnalyticsSummary,
  type CostPerConversation,
} from './CostAnalyticsService';

export {
  calculateLlmCostCents,
  calculateSttCostCents,
  calculateTtsCostCents,
  calculateInfraCostCents,
  getModelRate,
  TIER_MODEL_MAP,
  type ModelTier,
  type ModelRate,
} from './providerRates';

const sessionCacheCounters = new Map<string, { hits: number; misses: number }>();

export function getSessionCacheCounters(callSessionId: string): { hits: number; misses: number } {
  return sessionCacheCounters.get(callSessionId) ?? { hits: 0, misses: 0 };
}

export function recordSessionCacheHit(callSessionId: string): void {
  const c = sessionCacheCounters.get(callSessionId) ?? { hits: 0, misses: 0 };
  c.hits++;
  sessionCacheCounters.set(callSessionId, c);
}

export function recordSessionCacheMiss(callSessionId: string): void {
  const c = sessionCacheCounters.get(callSessionId) ?? { hits: 0, misses: 0 };
  c.misses++;
  sessionCacheCounters.set(callSessionId, c);
}

export function clearSessionCacheCounters(callSessionId: string): void {
  sessionCacheCounters.delete(callSessionId);
}
