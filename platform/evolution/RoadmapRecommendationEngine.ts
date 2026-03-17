import { withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('ROADMAP_RECOMMENDATIONS');

export interface RoadmapRecommendation {
  id: string;
  opportunityId: string | null;
  title: string;
  problemDetected: string;
  evidenceSummary: string | null;
  affectedSegments: unknown[];
  expectedBusinessImpact: Record<string, unknown>;
  implementationComplexity: string;
  recommendedPriority: string;
  estimatedRevenueImpactCents: number;
  estimatedEffortDays: number;
  aiExplanation: string | null;
  status: string;
  statusChangedBy: string | null;
  statusChangedAt: string | null;
  statusReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const STRATEGIST_PROMPT = `You are an AI Product Strategist for a Voice AI platform (QVO). Given a detected product opportunity with its evidence data, generate a compelling natural-language explanation that a C-level executive can act on.

Your explanation should:
1. Start with the specific insight discovered (e.g., "Over the last 45 days, 27 HVAC tenants requested recurring maintenance workflows...")
2. Cite concrete numbers from the evidence
3. Explain the business impact clearly
4. Recommend a specific course of action
5. Estimate the revenue impact if possible

Keep it concise (2-4 paragraphs). Be specific, data-driven, and actionable.

Return ONLY a JSON object:
{
  "explanation": "<your natural language explanation>",
  "problem_summary": "<one sentence problem statement>",
  "affected_segments": ["<segment1>", "<segment2>"],
  "expected_impact": {
    "revenue_impact_description": "<description>",
    "retention_impact_description": "<description>",
    "estimated_revenue_cents": <number>
  },
  "recommended_priority": "<critical|high|medium|low>",
  "implementation_complexity": "<low|medium|high|very_high>",
  "estimated_effort_days": <number>
}`;

function redactForAI(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['tenantId', 'tenant_id', 'tenantIds', 'tenant_ids', 'email', 'phone', 'ip', 'apiKey', 'token'];
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (sensitiveKeys.includes(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      redacted[k] = redactForAI(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      redacted[k] = v.map(item =>
        item && typeof item === 'object' ? redactForAI(item as Record<string, unknown>) : item,
      );
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

async function generateAIExplanation(opportunity: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping AI explanation generation');
    return null;
  }

  const sanitized = redactForAI(opportunity);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: STRATEGIST_PROMPT },
          {
            role: 'user',
            content: `Analyze this product opportunity and generate a strategic recommendation:\n\n${JSON.stringify(sanitized, null, 2)}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error during explanation generation', { status: response.status });
      return null;
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content);
  } catch (err) {
    logger.error('Failed to generate AI explanation', { error: String(err) });
    return null;
  }
}

export async function generateRoadmapRecommendations(): Promise<number> {
  logger.info('Starting roadmap recommendation generation');

  return withPrivilegedClient(async (client) => {
    const { rows: opportunities } = await client.query(
      `SELECT * FROM evolution_opportunities
       WHERE status = 'active' AND composite_score >= 3.0
         AND id NOT IN (SELECT opportunity_id FROM roadmap_recommendations WHERE opportunity_id IS NOT NULL)
       ORDER BY composite_score DESC
       LIMIT 20`,
    );

    let generated = 0;

    for (const opp of opportunities) {
      const compositeScore = parseFloat(String(opp.composite_score)) || 0;
      const aiResult = await generateAIExplanation({
        type: opp.opportunity_type,
        title: opp.title,
        description: opp.description,
        compositeScore,
        signalCount: opp.signal_count,
        affectedTenantCount: opp.affected_tenant_count,
        evidence: opp.evidence,
        scores: {
          customerDemand: opp.customer_demand_score,
          revenuePotential: opp.revenue_potential_score,
          strategicFit: opp.strategic_fit_score,
          developmentEffort: opp.development_effort_score,
          retentionImpact: opp.retention_impact_score,
          differentiation: opp.differentiation_score,
        },
      });

      const explanation = aiResult?.explanation ?? null;
      const problemSummary = aiResult?.problem_summary ?? opp.description ?? opp.title;
      const affectedSegments = aiResult?.affected_segments ?? [];
      const expectedImpact = aiResult?.expected_impact ?? {};
      const priority = aiResult?.recommended_priority ?? (compositeScore >= 7 ? 'high' : compositeScore >= 5 ? 'medium' : 'low');
      const complexity = aiResult?.implementation_complexity ?? 'medium';
      const effortDays = aiResult?.estimated_effort_days ?? 14;
      const revenueCents = (expectedImpact as Record<string, unknown>)?.estimated_revenue_cents ?? 0;

      await client.query(
        `INSERT INTO roadmap_recommendations (
           opportunity_id, title, problem_detected, evidence_summary,
           affected_segments, expected_business_impact, implementation_complexity,
           recommended_priority, estimated_revenue_impact_cents, estimated_effort_days,
           ai_explanation
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          opp.id,
          opp.title,
          String(problemSummary),
          JSON.stringify(opp.evidence),
          JSON.stringify(affectedSegments),
          JSON.stringify(expectedImpact),
          String(complexity),
          String(priority),
          typeof revenueCents === 'number' ? revenueCents : 0,
          typeof effortDays === 'number' ? effortDays : 14,
          explanation ? String(explanation) : null,
        ],
      );

      generated++;
    }

    logger.info('Roadmap recommendation generation completed', { generated });
    return generated;
  });
}

export async function getRecommendations(options: {
  status?: string;
  priority?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ recommendations: RoadmapRecommendation[]; total: number }> {
  return withPrivilegedClient(async (client) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.status) {
      conditions.push(`status = $${idx++}`);
      params.push(options.status);
    }
    if (options.priority) {
      conditions.push(`recommended_priority = $${idx++}`);
      params.push(options.priority);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM roadmap_recommendations ${where}`,
      params,
    );

    const { rows } = await client.query(
      `SELECT * FROM roadmap_recommendations ${where} ORDER BY
         CASE recommended_priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return {
      recommendations: rows.map(mapRecommendationRow),
      total: parseInt(String(countRows[0]?.total ?? 0), 10),
    };
  });
}

export async function updateRecommendationStatus(
  id: string,
  status: string,
  userId: string,
  reason?: string,
): Promise<RoadmapRecommendation | null> {
  const validStatuses = ['proposed', 'approved', 'rejected', 'deferred', 'in_progress', 'completed'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  return withPrivilegedClient(async (client) => {
    const { rows: oldRows } = await client.query(
      `SELECT * FROM roadmap_recommendations WHERE id = $1`,
      [id],
    );

    if (oldRows.length === 0) return null;

    const { rows } = await client.query(
      `UPDATE roadmap_recommendations SET
         status = $1, status_changed_by = $2, status_changed_at = NOW(),
         status_reason = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, userId, reason || null, id],
    );

    await client.query(
      `INSERT INTO evolution_audit_log (entity_type, entity_id, action, old_value, new_value, performed_by)
       VALUES ('roadmap_recommendation', $1, 'status_change', $2, $3, $4)`,
      [
        id,
        JSON.stringify({ status: oldRows[0].status }),
        JSON.stringify({ status, reason: reason || null }),
        userId,
      ],
    );

    return rows[0] ? mapRecommendationRow(rows[0]) : null;
  });
}

export async function getRecommendationById(id: string): Promise<RoadmapRecommendation | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM roadmap_recommendations WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRecommendationRow(rows[0]) : null;
  });
}

function mapRecommendationRow(row: Record<string, unknown>): RoadmapRecommendation {
  return {
    id: String(row.id),
    opportunityId: row.opportunity_id ? String(row.opportunity_id) : null,
    title: String(row.title),
    problemDetected: String(row.problem_detected),
    evidenceSummary: row.evidence_summary ? String(row.evidence_summary) : null,
    affectedSegments: (row.affected_segments as unknown[]) ?? [],
    expectedBusinessImpact: (row.expected_business_impact as Record<string, unknown>) ?? {},
    implementationComplexity: String(row.implementation_complexity),
    recommendedPriority: String(row.recommended_priority),
    estimatedRevenueImpactCents: parseInt(String(row.estimated_revenue_impact_cents), 10) || 0,
    estimatedEffortDays: parseInt(String(row.estimated_effort_days), 10) || 0,
    aiExplanation: row.ai_explanation ? String(row.ai_explanation) : null,
    status: String(row.status),
    statusChangedBy: row.status_changed_by ? String(row.status_changed_by) : null,
    statusChangedAt: row.status_changed_at ? String(row.status_changed_at) : null,
    statusReason: row.status_reason ? String(row.status_reason) : null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
