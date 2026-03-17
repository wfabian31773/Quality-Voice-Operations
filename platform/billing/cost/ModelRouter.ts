import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import { TIER_MODEL_MAP, type ModelTier } from './providerRates';

const logger = createLogger('MODEL_ROUTER');

export interface RoutingDecision {
  tier: ModelTier;
  model: string;
  reason: string;
  complexityScore: number;
}

const SIMPLE_PATTERNS = [
  /what (are|is) (your|the) (hours|business hours|opening hours)/i,
  /when (are|do) you open/i,
  /what('s| is) (your|the) (address|location)/i,
  /where (are|is) you located/i,
  /how much (does|do|is)/i,
  /what('s| is) (your|the) (price|pricing|cost|fee)/i,
  /what('s| is) (your|the) (phone|number|email)/i,
  /do you (accept|take) (insurance|credit|cash)/i,
  /yes/i,
  /no/i,
  /thank you/i,
  /thanks/i,
  /goodbye/i,
  /ok(ay)?/i,
  /that('s| is) (correct|right|fine)/i,
  /can i (book|make|schedule) (an? )?(appointment|reservation)/i,
  /i('d| would) like to (book|make|schedule)/i,
];

const COMPLEX_PATTERNS = [
  /explain|describe|compare|analyze|recommend/i,
  /what would you suggest/i,
  /can you help me (understand|figure out|decide)/i,
  /i('m| am) (not sure|confused|uncertain)/i,
  /what (are|is) the (difference|pros and cons|benefits)/i,
  /my situation is/i,
  /it('s| is) complicated/i,
  /multiple (issues|problems|concerns)/i,
  /medical|emergency|urgent|legal/i,
];

export function classifyComplexity(utterance: string): { score: number; reason: string } {
  const normalized = utterance.trim();

  if (normalized.length < 10) {
    return { score: 0.1, reason: 'Very short utterance' };
  }

  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { score: 0.2, reason: 'Matches simple/FAQ pattern' };
    }
  }

  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(normalized)) {
      return { score: 0.8, reason: 'Matches complex reasoning pattern' };
    }
  }

  const wordCount = normalized.split(/\s+/).length;
  if (wordCount > 30) {
    return { score: 0.7, reason: 'Long multi-clause utterance' };
  }
  if (wordCount > 15) {
    return { score: 0.5, reason: 'Medium-length utterance' };
  }

  return { score: 0.4, reason: 'Default complexity' };
}

export function routeToTier(complexityScore: number): ModelTier {
  if (complexityScore <= 0.3) return 'economy';
  if (complexityScore <= 0.6) return 'standard';
  return 'premium';
}

export function routeQuery(utterance: string): RoutingDecision {
  const { score, reason } = classifyComplexity(utterance);
  const tier = routeToTier(score);
  const model = TIER_MODEL_MAP[tier];

  return { tier, model, reason, complexityScore: score };
}

export async function logRoutingDecision(
  tenantId: string,
  callSessionId: string,
  decision: RoutingDecision,
  queryText?: string,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    await client.query(
      `INSERT INTO model_routing_log (id, tenant_id, call_session_id, query_text, complexity_score, routed_tier, reason)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::model_tier, $6)`,
      [tenantId, callSessionId, queryText?.substring(0, 500) ?? null, decision.complexityScore, decision.tier, decision.reason],
    );
  } catch (err) {
    logger.error('Failed to log routing decision', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function getRoutingDistribution(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<Array<{ tier: ModelTier; count: number; percentage: number }>> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT routed_tier as tier, COUNT(*)::int as count
       FROM model_routing_log
       WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3
       GROUP BY routed_tier
       ORDER BY count DESC`,
      [tenantId, from.toISOString(), to.toISOString()],
    );
    const total = rows.reduce((sum: number, r: any) => sum + r.count, 0);
    return rows.map((r: any) => ({
      tier: r.tier as ModelTier,
      count: r.count,
      percentage: total > 0 ? Math.round((r.count / total) * 100) : 0,
    }));
  } finally {
    client.release();
  }
}
