import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('COST_ANALYTICS');

export interface CostPerConversation {
  callSessionId: string;
  sttCostCents: number;
  llmCostCents: number;
  ttsCostCents: number;
  infraCostCents: number;
  totalCostCents: number;
  modelTier: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  createdAt: string;
}

export interface CostAnalyticsSummary {
  totalConversations: number;
  totalCostCents: number;
  avgCostPerConversationCents: number;
  totalSttCostCents: number;
  totalLlmCostCents: number;
  totalTtsCostCents: number;
  totalInfraCostCents: number;
  totalTokensSaved: number;
  totalCacheHits: number;
  totalCacheMisses: number;
  cacheHitRate: number;
  modelEfficiencyRatio: number;
  dailyBreakdown: Array<{
    date: string;
    totalCostCents: number;
    conversationCount: number;
    avgCostCents: number;
    cacheHits: number;
  }>;
  tierDistribution: Array<{
    tier: string;
    count: number;
    percentage: number;
    avgCostCents: number;
  }>;
  monthlyCostTrend: Array<{
    month: string;
    totalCostCents: number;
    conversationCount: number;
  }>;
  savingsBreakdown: {
    cacheSavingsCents: number;
    routingSavingsCents: number;
    compressionSavingsCents: number;
    totalSavingsCents: number;
  };
}

export async function getCostOptimizationAnalytics(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<CostAnalyticsSummary> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: summary } = await client.query(
      `SELECT
         COUNT(*)::int as total_conversations,
         COALESCE(SUM(total_cost_cents), 0)::int as total_cost_cents,
         COALESCE(AVG(total_cost_cents), 0)::int as avg_cost_cents,
         COALESCE(SUM(stt_cost_cents), 0)::int as total_stt,
         COALESCE(SUM(llm_cost_cents), 0)::int as total_llm,
         COALESCE(SUM(tts_cost_cents), 0)::int as total_tts,
         COALESCE(SUM(infra_cost_cents), 0)::int as total_infra,
         COALESCE(SUM(prompt_tokens_saved), 0)::int as total_tokens_saved,
         COALESCE(SUM(cache_hits), 0)::int as total_cache_hits,
         COALESCE(SUM(cache_misses), 0)::int as total_cache_misses
       FROM conversation_costs
       WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3`,
      [tenantId, from.toISOString(), to.toISOString()],
    );

    const s = summary[0];
    const totalCacheHits = s.total_cache_hits;
    const totalCacheMisses = s.total_cache_misses;
    const cacheHitRate = (totalCacheHits + totalCacheMisses) > 0
      ? Math.round((totalCacheHits / (totalCacheHits + totalCacheMisses)) * 100)
      : 0;

    const { rows: dailyRows } = await client.query(
      `SELECT
         DATE(created_at) as date,
         COALESCE(SUM(total_cost_cents), 0)::int as total_cost_cents,
         COUNT(*)::int as conversation_count,
         COALESCE(AVG(total_cost_cents), 0)::int as avg_cost_cents,
         COALESCE(SUM(cache_hits), 0)::int as cache_hits
       FROM conversation_costs
       WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3
       GROUP BY DATE(created_at)
       ORDER BY date`,
      [tenantId, from.toISOString(), to.toISOString()],
    );

    const { rows: tierRows } = await client.query(
      `SELECT
         model_tier as tier,
         COUNT(*)::int as count,
         COALESCE(AVG(total_cost_cents), 0)::int as avg_cost_cents
       FROM conversation_costs
       WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3
       GROUP BY model_tier
       ORDER BY count DESC`,
      [tenantId, from.toISOString(), to.toISOString()],
    );

    const totalTierCount = tierRows.reduce((sum: number, r: any) => sum + r.count, 0);

    const { rows: monthlyRows } = await client.query(
      `SELECT
         TO_CHAR(created_at, 'YYYY-MM') as month,
         COALESCE(SUM(total_cost_cents), 0)::int as total_cost_cents,
         COUNT(*)::int as conversation_count
       FROM conversation_costs
       WHERE tenant_id = $1 AND created_at >= (NOW() - INTERVAL '6 months')
       GROUP BY TO_CHAR(created_at, 'YYYY-MM')
       ORDER BY month`,
      [tenantId],
    );

    const economyCount = tierRows.find((r: any) => r.tier === 'economy')?.count ?? 0;
    const premiumAvgCost = tierRows.find((r: any) => r.tier === 'premium')?.avg_cost_cents ?? s.avg_cost_cents;
    const economyAvgCost = tierRows.find((r: any) => r.tier === 'economy')?.avg_cost_cents ?? 0;
    const routingSavings = economyCount * Math.max(0, premiumAvgCost - economyAvgCost);

    const cacheSavings = totalCacheHits * (s.avg_cost_cents || 0);
    const compressionSavings = Math.ceil(s.total_tokens_saved * 0.001 * 0.25);

    const economyTotalCost = tierRows.find((r: any) => r.tier === 'economy')?.avg_cost_cents ?? 0;
    const standardTotalCost = tierRows.find((r: any) => r.tier === 'standard')?.avg_cost_cents ?? s.avg_cost_cents;
    const modelEfficiencyRatio = standardTotalCost > 0 && s.avg_cost_cents > 0
      ? Math.round((standardTotalCost / s.avg_cost_cents) * 100) / 100
      : 1.0;

    await client.query('COMMIT');

    return {
      totalConversations: s.total_conversations,
      totalCostCents: s.total_cost_cents,
      avgCostPerConversationCents: s.avg_cost_cents,
      totalSttCostCents: s.total_stt,
      totalLlmCostCents: s.total_llm,
      totalTtsCostCents: s.total_tts,
      totalInfraCostCents: s.total_infra,
      totalTokensSaved: s.total_tokens_saved,
      totalCacheHits,
      totalCacheMisses,
      cacheHitRate,
      modelEfficiencyRatio,
      dailyBreakdown: dailyRows.map((r: any) => ({
        date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
        totalCostCents: r.total_cost_cents,
        conversationCount: r.conversation_count,
        avgCostCents: r.avg_cost_cents,
        cacheHits: r.cache_hits,
      })),
      tierDistribution: tierRows.map((r: any) => ({
        tier: r.tier,
        count: r.count,
        percentage: totalTierCount > 0 ? Math.round((r.count / totalTierCount) * 100) : 0,
        avgCostCents: r.avg_cost_cents,
      })),
      monthlyCostTrend: monthlyRows.map((r: any) => ({
        month: r.month,
        totalCostCents: r.total_cost_cents,
        conversationCount: r.conversation_count,
      })),
      savingsBreakdown: {
        cacheSavingsCents: cacheSavings,
        routingSavingsCents: routingSavings,
        compressionSavingsCents: compressionSavings,
        totalSavingsCents: cacheSavings + routingSavings + compressionSavings,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to fetch cost optimization analytics', { tenantId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

export async function getConversationCosts(
  tenantId: string,
  from: Date,
  to: Date,
  limit: number = 50,
  offset: number = 0,
): Promise<{ costs: CostPerConversation[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int as total FROM conversation_costs WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3`,
      [tenantId, from.toISOString(), to.toISOString()],
    );

    const { rows } = await client.query(
      `SELECT * FROM conversation_costs
       WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5`,
      [tenantId, from.toISOString(), to.toISOString(), limit, offset],
    );

    return {
      costs: rows.map((r: any) => ({
        callSessionId: r.call_session_id,
        sttCostCents: r.stt_cost_cents,
        llmCostCents: r.llm_cost_cents,
        ttsCostCents: r.tts_cost_cents,
        infraCostCents: r.infra_cost_cents,
        totalCostCents: r.total_cost_cents,
        modelTier: r.model_tier,
        modelUsed: r.model_used,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheHits: r.cache_hits,
        createdAt: r.created_at,
      })),
      total: countRows[0]?.total ?? 0,
    };
  } finally {
    client.release();
  }
}
