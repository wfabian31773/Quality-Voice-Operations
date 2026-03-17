import { getPlatformPool, withTenantContext, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('GIN_RECOMMENDATIONS');

export interface NetworkRecommendation {
  id: string;
  tenantId: string;
  sourcePatternId: string | null;
  title: string;
  description: string;
  recommendationType: string;
  industryVertical: string | null;
  estimatedImpact: string | null;
  confidenceScore: number;
  status: string;
  createdAt: string;
}

export async function distributeRecommendations(): Promise<number> {
  return withPrivilegedClient(async (client) => {
    try {
      const { rows: participatingTenants } = await client.query(
        `SELECT t.id, ARRAY_AGG(DISTINCT a.type) FILTER (WHERE a.type IS NOT NULL) AS agent_types
         FROM tenants t
         LEFT JOIN agents a ON a.tenant_id = t.id AND a.status = 'deployed'
         WHERE t.status = 'active' AND t.gin_participation = TRUE
         GROUP BY t.id
         LIMIT 500`,
      );

      const { rows: patterns } = await client.query(
        `SELECT * FROM global_insight_patterns
         WHERE is_active = TRUE AND confidence_score >= 0.5
         ORDER BY confidence_score DESC
         LIMIT 50`,
      );

      if (patterns.length === 0) {
        logger.info('No active patterns to distribute');
        return 0;
      }

      let totalDistributed = 0;

      for (const tenant of participatingTenants) {
        const tenantId = tenant.id as string;
        const agentTypes = (tenant.agent_types as string[]) || [];
        const tenantIndustry = detectIndustry(agentTypes);

        const { rows: existingRecs } = await client.query(
          `SELECT source_pattern_id FROM network_recommendations
           WHERE tenant_id = $1 AND created_at >= (NOW() - INTERVAL '30 days')`,
          [tenantId],
        );
        const existingPatternIds = new Set(existingRecs.map(r => r.source_pattern_id as string));

        for (const pattern of patterns) {
          const patternId = pattern.id as string;
          if (existingPatternIds.has(patternId)) continue;

          const patternIndustry = pattern.industry_vertical as string | null;
          if (patternIndustry && patternIndustry !== tenantIndustry && patternIndustry !== 'general') continue;

          await client.query(
            `INSERT INTO network_recommendations (tenant_id, source_pattern_id, title, description, recommendation_type, industry_vertical, estimated_impact, confidence_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              tenantId,
              patternId,
              pattern.title,
              pattern.description,
              pattern.pattern_type,
              patternIndustry,
              pattern.impact_estimate || null,
              parseFloat(String(pattern.confidence_score ?? 0.5)),
            ],
          );
          totalDistributed++;
        }
      }

      logger.info('Recommendation distribution completed', { totalDistributed, tenantCount: participatingTenants.length });
      return totalDistributed;
    } catch (err) {
      logger.error('Recommendation distribution failed', { error: String(err) });
      return 0;
    }
  });
}

export async function getTenantRecommendations(
  tenantId: string,
  options: { status?: string; limit?: number; offset?: number } = {},
): Promise<{ recommendations: NetworkRecommendation[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    return await withTenantContext(client, tenantId, async () => {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (options.status) {
        conditions.push(`status = $${idx}`);
        params.push(options.status);
        idx++;
      }

      const where = conditions.join(' AND ');
      const limit = Math.min(options.limit ?? 50, 100);
      const offset = options.offset ?? 0;

      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM network_recommendations WHERE ${where}`,
        params,
      );

      const { rows } = await client.query(
        `SELECT * FROM network_recommendations WHERE ${where} ORDER BY confidence_score DESC, created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      );

      return {
        recommendations: rows.map(mapRecommendationRow),
        total: countRows[0]?.total ?? 0,
      };
    });
  } finally {
    client.release();
  }
}

export async function updateRecommendationStatus(
  tenantId: string,
  recommendationId: string,
  status: 'applied' | 'dismissed',
): Promise<NetworkRecommendation | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    return await withTenantContext(client, tenantId, async () => {
      const timestampField = status === 'applied' ? 'applied_at' : 'dismissed_at';
      const { rows } = await client.query(
        `UPDATE network_recommendations SET status = $1, ${timestampField} = NOW(), updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3
         RETURNING *`,
        [status, recommendationId, tenantId],
      );
      return rows[0] ? mapRecommendationRow(rows[0]) : null;
    });
  } finally {
    client.release();
  }
}

export async function getNetworkRecommendationsForAssistant(
  tenantId: string,
  limit = 5,
): Promise<NetworkRecommendation[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    return await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM network_recommendations
         WHERE tenant_id = $1 AND status = 'pending'
         ORDER BY confidence_score DESC, created_at DESC
         LIMIT $2`,
        [tenantId, limit],
      );
      return rows.map(mapRecommendationRow);
    });
  } finally {
    client.release();
  }
}

function detectIndustry(agentTypes: string[]): string {
  const typeMap: Record<string, string> = {
    'dental': 'dental',
    'medical-after-hours': 'medical',
    'home-services': 'home_services',
    'property-management': 'property_management',
    'legal': 'legal',
  };
  for (const t of agentTypes) {
    if (typeMap[t]) return typeMap[t];
  }
  return 'general';
}

function mapRecommendationRow(row: Record<string, unknown>): NetworkRecommendation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    sourcePatternId: (row.source_pattern_id as string) || null,
    title: row.title as string,
    description: row.description as string,
    recommendationType: row.recommendation_type as string,
    industryVertical: (row.industry_vertical as string) || null,
    estimatedImpact: (row.estimated_impact as string) || null,
    confidenceScore: parseFloat(String(row.confidence_score ?? 0)),
    status: row.status as string,
    createdAt: String(row.created_at),
  };
}
