import { withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('OPPORTUNITY_DETECTION');

export interface EvolutionOpportunity {
  id: string;
  opportunityType: string;
  title: string;
  description: string | null;
  status: string;
  customerDemandScore: number;
  revenuePotentialScore: number;
  strategicFitScore: number;
  developmentEffortScore: number;
  retentionImpactScore: number;
  differentiationScore: number;
  compositeScore: number;
  signalCount: number;
  affectedTenantCount: number;
  evidence: unknown[];
  metadata: Record<string, unknown>;
  firstDetectedAt: string;
  lastSignalAt: string;
  createdAt: string;
  updatedAt: string;
}

const SCORING_WEIGHTS = {
  customerDemand: 0.25,
  revenuePotential: 0.20,
  strategicFit: 0.15,
  developmentEffort: 0.15,
  retentionImpact: 0.15,
  differentiation: 0.10,
};

function computeCompositeScore(scores: {
  customerDemand: number;
  revenuePotential: number;
  strategicFit: number;
  developmentEffort: number;
  retentionImpact: number;
  differentiation: number;
}): number {
  return (
    scores.customerDemand * SCORING_WEIGHTS.customerDemand +
    scores.revenuePotential * SCORING_WEIGHTS.revenuePotential +
    scores.strategicFit * SCORING_WEIGHTS.strategicFit +
    (10 - scores.developmentEffort) * SCORING_WEIGHTS.developmentEffort +
    scores.retentionImpact * SCORING_WEIGHTS.retentionImpact +
    scores.differentiation * SCORING_WEIGHTS.differentiation
  );
}

async function detectVerticalOpportunities(): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT signal_type, raw_data, strength, COUNT(*)::int AS signal_count,
              COUNT(DISTINCT tenant_id)::int AS tenant_count
       FROM evolution_signals
       WHERE signal_type = 'vertical_demand'
         AND collected_at >= NOW() - INTERVAL '30 days'
       GROUP BY signal_type, raw_data, strength
       ORDER BY signal_count DESC`,
    );

    for (const row of rows) {
      const data = (row.raw_data ?? {}) as Record<string, unknown>;
      const vertical = String(data.vertical ?? 'unknown');
      const tenantCount = parseInt(String(data.tenantCount ?? String(row.tenant_count)), 10) || 0;
      const totalCalls = parseInt(String(data.totalCalls ?? 0), 10) || 0;

      const scores = {
        customerDemand: Math.min(tenantCount * 2, 10),
        revenuePotential: Math.min(totalCalls / 10, 10),
        strategicFit: 7,
        developmentEffort: 5,
        retentionImpact: Math.min(tenantCount * 1.5, 10),
        differentiation: 6,
      };

      const composite = computeCompositeScore(scores);

      const signalCount = parseInt(String(row.signal_count), 10) || 0;
      await client.query(
        `INSERT INTO evolution_opportunities (
           opportunity_type, title, description, customer_demand_score,
           revenue_potential_score, strategic_fit_score, development_effort_score,
           retention_impact_score, differentiation_score, composite_score,
           signal_count, affected_tenant_count, evidence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (opportunity_type, title) DO UPDATE SET
           composite_score = EXCLUDED.composite_score,
           signal_count = EXCLUDED.signal_count,
           affected_tenant_count = EXCLUDED.affected_tenant_count,
           customer_demand_score = EXCLUDED.customer_demand_score,
           revenue_potential_score = EXCLUDED.revenue_potential_score,
           retention_impact_score = EXCLUDED.retention_impact_score,
           last_signal_at = NOW(), updated_at = NOW()`,
        [
          'missing_vertical',
          `Vertical expansion opportunity: ${vertical}`,
          `${tenantCount} tenants are actively using ${vertical} agents with ${totalCalls} calls`,
          scores.customerDemand, scores.revenuePotential, scores.strategicFit,
          scores.developmentEffort, scores.retentionImpact, scores.differentiation,
          composite, signalCount, tenantCount,
          JSON.stringify([{ type: 'vertical_demand', vertical, tenantCount, totalCalls }]),
        ],
      );

      await client.query(
        `INSERT INTO vertical_expansion_scores (vertical_name, current_tenant_count, expansion_score, demand_signals)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (vertical_name) DO UPDATE SET
           current_tenant_count = EXCLUDED.current_tenant_count,
           expansion_score = EXCLUDED.expansion_score,
           demand_signals = EXCLUDED.demand_signals,
           updated_at = NOW()`,
        [vertical, tenantCount, composite, JSON.stringify([{ tenantCount, totalCalls }])],
      );
    }

    logger.info('Detected vertical opportunities', { count: rows.length });
  });
}

async function detectMarketplaceGaps(): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT signal_type, raw_data, strength, COUNT(*)::int AS signal_count
       FROM evolution_signals
       WHERE source = 'marketplace'
         AND collected_at >= NOW() - INTERVAL '30 days'
       GROUP BY signal_type, raw_data, strength
       ORDER BY signal_count DESC`,
    );

    for (const row of rows) {
      const data = (row.raw_data ?? {}) as Record<string, unknown>;

      if (String(row.signal_type) === 'high_uninstall_rate') {
        const scores = {
          customerDemand: 6,
          revenuePotential: 5,
          strategicFit: 7,
          developmentEffort: 4,
          retentionImpact: 7,
          differentiation: 5,
        };
        const composite = computeCompositeScore(scores);
        const templateSlug = String(data.templateSlug ?? String(row.signal_type ?? 'unknown'));

        await client.query(
          `INSERT INTO evolution_opportunities (
             opportunity_type, title, description, customer_demand_score,
             revenue_potential_score, strategic_fit_score, development_effort_score,
             retention_impact_score, differentiation_score, composite_score,
             signal_count, evidence
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (opportunity_type, title) DO UPDATE SET
             composite_score = EXCLUDED.composite_score,
             signal_count = EXCLUDED.signal_count,
             evidence = EXCLUDED.evidence,
             last_signal_at = NOW(), updated_at = NOW()`,
          [
            'marketplace_gap',
            `Marketplace quality issue: ${templateSlug}`,
            `High uninstall rate detected for template ${templateSlug}`,
            scores.customerDemand, scores.revenuePotential, scores.strategicFit,
            scores.developmentEffort, scores.retentionImpact, scores.differentiation,
            composite, row.signal_count,
            JSON.stringify([{ type: 'high_uninstall_rate', ...data }]),
          ],
        );

        await client.query(
          `INSERT INTO marketplace_opportunity_scores (template_category, gap_description, demand_score, uninstall_rate)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (template_category) DO UPDATE SET
             gap_description = EXCLUDED.gap_description,
             demand_score = EXCLUDED.demand_score,
             uninstall_rate = EXCLUDED.uninstall_rate,
             updated_at = NOW()`,
          [templateSlug, `High uninstall rate for ${templateSlug}`, composite, parseFloat(String(data.uninstallRate ?? 0))],
        );
      }
    }

    logger.info('Detected marketplace gaps', { signalCount: rows.length });
  });
}

async function detectRetentionRisks(): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT signal_type, tenant_id, title, raw_data, strength
       FROM evolution_signals
       WHERE source IN ('churn', 'usage_metrics')
         AND signal_type IN ('usage_decline', 'never_activated', 'inactive_tenant')
         AND collected_at >= NOW() - INTERVAL '30 days'
       ORDER BY strength DESC`,
    );

    const tenantSignals = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.tenant_id) continue;
      const tid = String(row.tenant_id);
      const existing = tenantSignals.get(tid) ?? [];
      existing.push(row);
      tenantSignals.set(tid, existing);
    }

    for (const [tenantId, signals] of tenantSignals) {
      if (signals.length < 1) continue;

      const avgStrength = signals.reduce((s, r) => s + (parseFloat(String(r.strength)) || 0), 0 as number) / signals.length;

      const scores = {
        customerDemand: 4,
        revenuePotential: Math.min(avgStrength * 2, 10),
        strategicFit: 8,
        developmentEffort: 3,
        retentionImpact: Math.min(avgStrength * 2.5, 10),
        differentiation: 4,
      };
      const composite = computeCompositeScore(scores);

      await client.query(
        `INSERT INTO evolution_opportunities (
           opportunity_type, title, description, customer_demand_score,
           revenue_potential_score, strategic_fit_score, development_effort_score,
           retention_impact_score, differentiation_score, composite_score,
           signal_count, affected_tenant_count, evidence, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (opportunity_type, title) DO UPDATE SET
           composite_score = EXCLUDED.composite_score,
           signal_count = EXCLUDED.signal_count,
           evidence = EXCLUDED.evidence,
           description = EXCLUDED.description,
           last_signal_at = NOW(), updated_at = NOW()`,
        [
          'retention_risk',
          `Retention risk: tenant ${tenantId}`,
          `${signals.length} risk signals detected including: ${signals.map(s => s.signal_type).join(', ')}`,
          scores.customerDemand, scores.revenuePotential, scores.strategicFit,
          scores.developmentEffort, scores.retentionImpact, scores.differentiation,
          composite, signals.length, 1,
          JSON.stringify(signals.map(s => ({ type: s.signal_type, title: s.title, strength: s.strength }))),
          JSON.stringify({ tenantId }),
        ],
      );
    }

    logger.info('Detected retention risks', { tenantCount: tenantSignals.size });
  });
}

async function detectIntegrationDemand(): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT signal_type, raw_data, strength, COUNT(*)::int AS signal_count,
              COUNT(DISTINCT tenant_id)::int AS tenant_count
       FROM evolution_signals
       WHERE signal_type = 'heavy_tool_usage'
         AND collected_at >= NOW() - INTERVAL '30 days'
       GROUP BY signal_type, raw_data, strength
       HAVING COUNT(DISTINCT tenant_id) >= 2
       ORDER BY signal_count DESC`,
    );

    for (const row of rows) {
      const iTenantCount = parseInt(String(row.tenant_count), 10) || 0;
      const iSignalCount = parseInt(String(row.signal_count), 10) || 0;
      const scores = {
        customerDemand: Math.min(iTenantCount * 2, 10),
        revenuePotential: 6,
        strategicFit: 7,
        developmentEffort: 5,
        retentionImpact: 5,
        differentiation: 7,
      };
      const composite = computeCompositeScore(scores);

      await client.query(
        `INSERT INTO integration_demand_scores (integration_name, demand_score, request_count, unique_tenant_count)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (integration_name) DO UPDATE SET
           demand_score = EXCLUDED.demand_score,
           request_count = EXCLUDED.request_count,
           unique_tenant_count = EXCLUDED.unique_tenant_count,
           updated_at = NOW()`,
        ['tool_integration_demand', composite, iSignalCount, iTenantCount],
      );
    }

    logger.info('Detected integration demand', { count: rows.length });
  });
}

async function detectOnboardingGaps(): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT signal_type, tenant_id, title, raw_data, strength,
              COUNT(*) OVER (PARTITION BY signal_type)::int AS type_count,
              COUNT(DISTINCT tenant_id) OVER (PARTITION BY signal_type)::int AS type_tenants
       FROM evolution_signals
       WHERE source = 'onboarding'
         AND collected_at >= NOW() - INTERVAL '30 days'
       ORDER BY strength DESC`,
    );

    const typeGroups = new Map<string, typeof rows>();
    for (const row of rows) {
      const st = String(row.signal_type);
      const arr = typeGroups.get(st) ?? [];
      arr.push(row);
      typeGroups.set(st, arr);
    }

    for (const [signalType, signals] of typeGroups) {
      if (signals.length < 2) continue;
      const tenantCount = new Set(signals.map(s => String(s.tenant_id))).size;
      const avgStrength = signals.reduce((s, r) => s + (parseFloat(String(r.strength)) || 0), 0 as number) / signals.length;

      const scores = {
        customerDemand: Math.min(tenantCount * 2, 10),
        revenuePotential: 7,
        strategicFit: 9,
        developmentEffort: 4,
        retentionImpact: 8,
        differentiation: 5,
      };
      const composite = computeCompositeScore(scores);

      await client.query(
        `INSERT INTO evolution_opportunities (
           opportunity_type, title, description, customer_demand_score,
           revenue_potential_score, strategic_fit_score, development_effort_score,
           retention_impact_score, differentiation_score, composite_score,
           signal_count, affected_tenant_count, evidence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (opportunity_type, title) DO UPDATE SET
           composite_score = EXCLUDED.composite_score,
           signal_count = EXCLUDED.signal_count,
           affected_tenant_count = EXCLUDED.affected_tenant_count,
           evidence = EXCLUDED.evidence,
           last_signal_at = NOW(), updated_at = NOW()`,
        [
          'onboarding_gap',
          `Onboarding gap: ${signalType} (${tenantCount} tenants affected)`,
          `${signals.length} signals indicate onboarding drop-off at ${signalType} stage`,
          scores.customerDemand, scores.revenuePotential, scores.strategicFit,
          scores.developmentEffort, scores.retentionImpact, scores.differentiation,
          composite, signals.length, tenantCount,
          JSON.stringify(signals.slice(0, 5).map(s => ({ type: s.signal_type, title: s.title, strength: s.strength }))),
        ],
      );
    }

    logger.info('Detected onboarding gaps', { typeCount: typeGroups.size });
  });
}

async function detectMissingToolsAndIntegrations(): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows: toolSignals } = await client.query(
      `SELECT raw_data, COUNT(*)::int AS signal_count,
              COUNT(DISTINCT tenant_id)::int AS tenant_count
       FROM evolution_signals
       WHERE signal_type = 'heavy_tool_usage'
         AND collected_at >= NOW() - INTERVAL '30 days'
       GROUP BY raw_data
       HAVING COUNT(DISTINCT tenant_id) >= 2
       ORDER BY signal_count DESC`,
    );

    for (const row of toolSignals) {
      const tc = parseInt(String(row.tenant_count), 10) || 0;
      const sc = parseInt(String(row.signal_count), 10) || 0;
      const scores = {
        customerDemand: Math.min(tc * 3, 10),
        revenuePotential: 6,
        strategicFit: 7,
        developmentEffort: 5,
        retentionImpact: 6,
        differentiation: 8,
      };
      const composite = computeCompositeScore(scores);

      await client.query(
        `INSERT INTO evolution_opportunities (
           opportunity_type, title, description, customer_demand_score,
           revenue_potential_score, strategic_fit_score, development_effort_score,
           retention_impact_score, differentiation_score, composite_score,
           signal_count, affected_tenant_count, evidence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (opportunity_type, title) DO UPDATE SET
           composite_score = EXCLUDED.composite_score,
           signal_count = EXCLUDED.signal_count,
           affected_tenant_count = EXCLUDED.affected_tenant_count,
           last_signal_at = NOW(), updated_at = NOW()`,
        [
          'missing_tool',
          `Tool enhancement opportunity (${tc} tenants with heavy usage)`,
          `Heavy tool usage across ${tc} tenants suggests demand for expanded tool capabilities`,
          scores.customerDemand, scores.revenuePotential, scores.strategicFit,
          scores.developmentEffort, scores.retentionImpact, scores.differentiation,
          composite, sc, tc,
          JSON.stringify([{ type: 'heavy_tool_usage', tenantCount: tc, signalCount: sc }]),
        ],
      );
    }

    const { rows: integrationSignals } = await client.query(
      `SELECT signal_type, raw_data,
              COUNT(*)::int AS signal_count,
              COUNT(DISTINCT tenant_id)::int AS tenant_count
       FROM evolution_signals
       WHERE source IN ('usage_metrics', 'feature_request')
         AND signal_type IN ('cross_tenant_pattern', 'heavy_tool_usage')
         AND collected_at >= NOW() - INTERVAL '30 days'
       GROUP BY signal_type, raw_data
       HAVING COUNT(DISTINCT tenant_id) >= 2
       ORDER BY signal_count DESC
       LIMIT 10`,
    );

    for (const row of integrationSignals) {
      const tc = parseInt(String(row.tenant_count), 10) || 0;
      const sc = parseInt(String(row.signal_count), 10) || 0;
      const scores = {
        customerDemand: Math.min(tc * 2.5, 10),
        revenuePotential: 7,
        strategicFit: 6,
        developmentEffort: 6,
        retentionImpact: 5,
        differentiation: 8,
      };
      const composite = computeCompositeScore(scores);

      await client.query(
        `INSERT INTO evolution_opportunities (
           opportunity_type, title, description, customer_demand_score,
           revenue_potential_score, strategic_fit_score, development_effort_score,
           retention_impact_score, differentiation_score, composite_score,
           signal_count, affected_tenant_count, evidence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (opportunity_type, title) DO UPDATE SET
           composite_score = EXCLUDED.composite_score,
           signal_count = EXCLUDED.signal_count,
           affected_tenant_count = EXCLUDED.affected_tenant_count,
           last_signal_at = NOW(), updated_at = NOW()`,
        [
          'missing_integration',
          `Integration demand: ${String(row.signal_type)} pattern (${tc} tenants)`,
          `Cross-tenant pattern "${row.signal_type}" across ${tc} tenants indicates integration demand`,
          scores.customerDemand, scores.revenuePotential, scores.strategicFit,
          scores.developmentEffort, scores.retentionImpact, scores.differentiation,
          composite, sc, tc,
          JSON.stringify([{ type: row.signal_type, tenantCount: tc, signalCount: sc }]),
        ],
      );

      await client.query(
        `INSERT INTO integration_demand_scores (integration_name, demand_score, request_count, unique_tenant_count)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (integration_name) DO UPDATE SET
           demand_score = EXCLUDED.demand_score,
           request_count = EXCLUDED.request_count,
           unique_tenant_count = EXCLUDED.unique_tenant_count,
           updated_at = NOW()`,
        [String(row.signal_type), composite, sc, tc],
      );
    }

    logger.info('Detected missing tools and integrations', { toolCount: toolSignals.length, integrationCount: integrationSignals.length });
  });
}

async function generateFeatureRequestClusters(): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT signal_type,
              COUNT(*)::int AS request_count,
              COUNT(DISTINCT tenant_id)::int AS unique_tenants,
              array_agg(DISTINCT title) AS titles
       FROM evolution_signals
       WHERE collected_at >= NOW() - INTERVAL '30 days'
       GROUP BY signal_type
       HAVING COUNT(*) >= 3
       ORDER BY request_count DESC`,
    );

    for (const row of rows) {
      const titles = (row.titles as string[]) || [];
      const { rows: existing } = await client.query(
        `SELECT id FROM feature_request_clusters WHERE cluster_name = $1`,
        [row.signal_type],
      );

      if (existing.length > 0) {
        await client.query(
          `UPDATE feature_request_clusters SET
             request_count = $1, unique_tenant_count = $2,
             representative_requests = $3, last_seen_at = NOW(), updated_at = NOW()
           WHERE id = $4`,
          [row.request_count, row.unique_tenants, JSON.stringify(titles.slice(0, 5)), existing[0].id],
        );
      } else {
        await client.query(
          `INSERT INTO feature_request_clusters (cluster_name, description, request_count, unique_tenant_count, representative_requests)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            row.signal_type,
            `Cluster of ${row.request_count} signals of type ${row.signal_type}`,
            row.request_count,
            row.unique_tenants,
            JSON.stringify(titles.slice(0, 5)),
          ],
        );
      }
    }

    logger.info('Generated feature request clusters', { count: rows.length });
  });
}

export async function runOpportunityDetection(): Promise<number> {
  logger.info('Starting opportunity detection');

  try {
    await detectVerticalOpportunities();
    await detectMarketplaceGaps();
    await detectRetentionRisks();
    await detectIntegrationDemand();
    await detectOnboardingGaps();
    await detectMissingToolsAndIntegrations();
    await generateFeatureRequestClusters();

    const count = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM evolution_opportunities WHERE status = 'active'`,
      );
      return parseInt(String(rows[0]?.count ?? 0), 10);
    });

    logger.info('Opportunity detection completed', { activeOpportunities: count });
    return count;
  } catch (err) {
    logger.error('Opportunity detection failed', { error: String(err) });
    throw err;
  }
}

export async function getOpportunities(options: {
  type?: string;
  status?: string;
  minScore?: number;
  limit?: number;
  offset?: number;
} = {}): Promise<{ opportunities: EvolutionOpportunity[]; total: number }> {
  return withPrivilegedClient(async (client) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.type) {
      conditions.push(`opportunity_type = $${idx++}`);
      params.push(options.type);
    }
    if (options.status) {
      conditions.push(`status = $${idx++}`);
      params.push(options.status);
    }
    if (options.minScore !== undefined) {
      conditions.push(`composite_score >= $${idx++}`);
      params.push(options.minScore);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM evolution_opportunities ${where}`,
      params,
    );

    const { rows } = await client.query(
      `SELECT * FROM evolution_opportunities ${where} ORDER BY composite_score DESC, last_signal_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return {
      opportunities: rows.map(mapOpportunityRow),
      total: parseInt(String(countRows[0]?.total ?? 0), 10),
    };
  });
}

export async function getOpportunityById(id: string): Promise<EvolutionOpportunity | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM evolution_opportunities WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapOpportunityRow(rows[0]) : null;
  });
}

function mapOpportunityRow(row: Record<string, unknown>): EvolutionOpportunity {
  return {
    id: String(row.id),
    opportunityType: String(row.opportunity_type),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    status: String(row.status),
    customerDemandScore: parseFloat(String(row.customer_demand_score)) || 0,
    revenuePotentialScore: parseFloat(String(row.revenue_potential_score)) || 0,
    strategicFitScore: parseFloat(String(row.strategic_fit_score)) || 0,
    developmentEffortScore: parseFloat(String(row.development_effort_score)) || 0,
    retentionImpactScore: parseFloat(String(row.retention_impact_score)) || 0,
    differentiationScore: parseFloat(String(row.differentiation_score)) || 0,
    compositeScore: parseFloat(String(row.composite_score)) || 0,
    signalCount: parseInt(String(row.signal_count), 10) || 0,
    affectedTenantCount: parseInt(String(row.affected_tenant_count), 10) || 0,
    evidence: (row.evidence as unknown[]) ?? [],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    firstDetectedAt: String(row.first_detected_at),
    lastSignalAt: String(row.last_signal_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
