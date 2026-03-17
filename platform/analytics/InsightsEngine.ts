import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('INSIGHTS_ENGINE');

export interface AiInsight {
  id: string;
  tenantId: string;
  category: string;
  title: string;
  description: string;
  impactEstimate: string | null;
  difficulty: string;
  estimatedRevenueImpactCents: number | null;
  status: string;
  actionType: string | null;
  actionPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  measuredImpact: Record<string, unknown> | null;
  analysisPeriodStart: string | null;
  analysisPeriodEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReport {
  id: string;
  tenantId: string;
  weekStart: string;
  weekEnd: string;
  summary: string;
  metricsSnapshot: Record<string, unknown>;
  topIssues: Array<Record<string, unknown>>;
  prioritizedActions: Array<Record<string, unknown>>;
  insightsGenerated: number;
  insightsAccepted: number;
  insightsDismissed: number;
  createdAt: string;
}

export interface InsightsSummary {
  totalInsights: number;
  newInsights: number;
  acceptedInsights: number;
  dismissedInsights: number;
  byCategory: Record<string, number>;
}

const INSIGHT_ANALYSIS_PROMPT = `You are an AI operations intelligence analyst for a voice AI platform. Analyze the provided operational data and generate actionable business insights.

For each insight, provide:
1. A clear, specific title
2. A detailed description explaining the pattern or opportunity
3. The category (one of: missed_opportunity, performance, cost_optimization, agent_improvement, workflow, scheduling)
4. Impact estimate description (e.g., "Could reduce no-shows by ~15%")
5. Estimated difficulty (easy, medium, hard)
6. An action type if applicable (update_prompt, add_tool, adjust_schedule, enable_feature, review_calls)

Return ONLY valid JSON array:
[
  {
    "title": "<specific actionable title>",
    "description": "<detailed explanation>",
    "category": "<category>",
    "impact_estimate": "<human-readable impact>",
    "difficulty": "<easy|medium|hard>",
    "estimated_revenue_impact_cents": <number or null>,
    "action_type": "<action type or null>",
    "action_payload": {}
  }
]

Focus on concrete, data-driven insights. Avoid generic advice. Each insight should reference specific numbers from the data.`;

export async function runInsightsAnalysis(tenantId: string): Promise<AiInsight[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping insights analysis');
    return [];
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { rows: callMetrics } = await client.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::int AS failed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated,
         COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration,
         COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
         COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
         COALESCE(SUM(total_cost_cents), 0)::int AS total_cost_cents
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: qualityMetrics } = await client.query(
      `SELECT
         COALESCE(AVG(score), 0)::float AS avg_quality,
         COUNT(*)::int AS scored_calls,
         COUNT(*) FILTER (WHERE score < 5)::int AS low_quality_calls
       FROM call_quality_scores
       WHERE tenant_id = $1 AND scored_at >= $2 AND scored_at < $3`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: toolMetrics } = await client.query(
      `SELECT
         COALESCE((payload->>'tool')::text, 'unknown') AS tool_name,
         COUNT(*)::int AS executions,
         COUNT(*) FILTER (WHERE event_type = 'TOOL_END')::int AS completed
       FROM call_events
       WHERE tenant_id = $1
         AND event_type IN ('TOOL_START', 'TOOL_END')
         AND occurred_at >= $2 AND occurred_at < $3
       GROUP BY (payload->>'tool')`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: agentMetrics } = await client.query(
      `SELECT
         a.id AS agent_id,
         a.name AS agent_name,
         COUNT(cs.id)::int AS total_calls,
         COALESCE(AVG(cs.duration_seconds) FILTER (WHERE cs.duration_seconds > 0), 0)::float AS avg_duration,
         COUNT(cs.id) FILTER (WHERE cs.lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(cs.id) FILTER (WHERE cs.lifecycle_state = 'CALL_FAILED')::int AS failed,
         COUNT(cs.id) FILTER (WHERE cs.lifecycle_state = 'ESCALATED' OR cs.escalation_target IS NOT NULL)::int AS escalated
       FROM agents a
       LEFT JOIN call_sessions cs ON cs.agent_id = a.id
         AND cs.created_at >= $2 AND cs.created_at < $3
       WHERE a.tenant_id = $1
       GROUP BY a.id, a.name`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: hourlyPatterns } = await client.query(
      `SELECT
         EXTRACT(HOUR FROM created_at)::int AS hour,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY EXTRACT(HOUR FROM created_at)
       ORDER BY hour`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: transcriptSamples } = await client.query(
      `SELECT cs.id, cs.lifecycle_state, cs.duration_seconds,
              LEFT(cs.context->>'transcript', 500) AS transcript_snippet
       FROM call_sessions cs
       WHERE cs.tenant_id = $1
         AND cs.created_at >= $2 AND cs.created_at < $3
         AND cs.context->>'transcript' IS NOT NULL
       ORDER BY cs.created_at DESC
       LIMIT 20`,
      [tenantId, sevenDaysAgo, now],
    );

    await client.query('COMMIT');

    const cm = callMetrics[0] || {};
    const qm = qualityMetrics[0] || {};

    const dataContext = JSON.stringify({
      period: { start: sevenDaysAgo.toISOString(), end: now.toISOString() },
      callMetrics: {
        totalCalls: cm.total_calls || 0,
        completed: cm.completed || 0,
        failed: cm.failed || 0,
        escalated: cm.escalated || 0,
        avgDurationSeconds: Math.round(cm.avg_duration || 0),
        inbound: cm.inbound || 0,
        outbound: cm.outbound || 0,
        totalCostCents: cm.total_cost_cents || 0,
        completionRate: cm.total_calls > 0 ? ((cm.completed / cm.total_calls) * 100).toFixed(1) + '%' : '0%',
        escalationRate: cm.total_calls > 0 ? ((cm.escalated / cm.total_calls) * 100).toFixed(1) + '%' : '0%',
      },
      qualityMetrics: {
        avgScore: parseFloat(String(qm.avg_quality || 0)).toFixed(1),
        scoredCalls: qm.scored_calls || 0,
        lowQualityCalls: qm.low_quality_calls || 0,
      },
      toolUsage: toolMetrics.map((t) => ({
        tool: t.tool_name,
        executions: t.executions,
        completed: t.completed,
      })),
      agentPerformance: agentMetrics.map((a) => ({
        name: a.agent_name,
        totalCalls: a.total_calls,
        avgDuration: Math.round(a.avg_duration),
        completed: a.completed,
        failed: a.failed,
        escalated: a.escalated,
      })),
      hourlyPatterns: hourlyPatterns.map((h) => ({
        hour: h.hour,
        calls: h.calls,
        escalated: h.escalated,
      })),
      transcriptSnippets: transcriptSamples.slice(0, 5).map((t) => ({
        state: t.lifecycle_state,
        duration: t.duration_seconds,
        snippet: t.transcript_snippet,
      })),
    });

    if ((cm.total_calls || 0) < 1) {
      logger.info('Not enough call data for insights analysis', { tenantId, totalCalls: cm.total_calls });
      return [];
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: INSIGHT_ANALYSIS_PROMPT },
          { role: 'user', content: `Analyze this operational data and generate insights:\n\n${dataContext}` },
        ],
        temperature: 0.4,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error during insights analysis', { status: response.status, tenantId });
      return [];
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.error('Empty response from OpenAI insights analysis', { tenantId });
      return [];
    }

    let rawInsights: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(content);
      rawInsights = Array.isArray(parsed) ? parsed : (parsed.insights || parsed.recommendations || [parsed]);
    } catch {
      logger.error('Failed to parse insights JSON', { tenantId });
      return [];
    }

    const insertedInsights: AiInsight[] = [];
    const insertClient = await pool.connect();
    try {
      await withTenantContext(insertClient, tenantId, async () => {
        for (const raw of rawInsights.slice(0, 10)) {
          const { rows } = await insertClient.query(
            `INSERT INTO ai_insights (
              tenant_id, category, title, description, impact_estimate,
              difficulty, estimated_revenue_impact_cents, action_type, action_payload,
              analysis_period_start, analysis_period_end
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *`,
            [
              tenantId,
              String(raw.category || 'general'),
              String(raw.title || 'Insight'),
              String(raw.description || ''),
              raw.impact_estimate ? String(raw.impact_estimate) : null,
              String(raw.difficulty || 'medium'),
              typeof raw.estimated_revenue_impact_cents === 'number' ? raw.estimated_revenue_impact_cents : null,
              raw.action_type ? String(raw.action_type) : null,
              JSON.stringify(raw.action_payload || {}),
              sevenDaysAgo,
              now,
            ],
          );

          if (rows[0]) {
            insertedInsights.push(mapInsightRow(rows[0]));
          }
        }
      });
    } finally {
      insertClient.release();
    }

    logger.info('Insights analysis completed', { tenantId, insightsGenerated: insertedInsights.length });
    return insertedInsights;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Insights analysis failed', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export async function getInsights(
  tenantId: string,
  options: { status?: string; category?: string; limit?: number; offset?: number } = {},
): Promise<{ insights: AiInsight[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  try {
    return await withTenantContext(client, tenantId, async () => {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let paramIdx = 2;

      if (options.status) {
        conditions.push(`status = $${paramIdx}`);
        params.push(options.status);
        paramIdx++;
      }
      if (options.category) {
        conditions.push(`category = $${paramIdx}`);
        params.push(options.category);
        paramIdx++;
      }

      const where = conditions.join(' AND ');

      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM ai_insights WHERE ${where}`,
        params,
      );

      const { rows } = await client.query(
        `SELECT * FROM ai_insights WHERE ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      );

      return {
        insights: rows.map(mapInsightRow),
        total: countRows[0]?.total ?? 0,
      };
    });
  } finally {
    client.release();
  }
}

export async function getInsightsSummary(tenantId: string): Promise<InsightsSummary> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    return await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'new')::int AS new_count,
           COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted_count,
           COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed_count
         FROM ai_insights
         WHERE tenant_id = $1`,
        [tenantId],
      );

      const { rows: catRows } = await client.query(
        `SELECT category, COUNT(*)::int AS count
         FROM ai_insights
         WHERE tenant_id = $1
         GROUP BY category`,
        [tenantId],
      );

      const byCategory: Record<string, number> = {};
      for (const r of catRows) {
        byCategory[r.category as string] = r.count as number;
      }

      const r = rows[0] || {};
      return {
        totalInsights: r.total ?? 0,
        newInsights: r.new_count ?? 0,
        acceptedInsights: r.accepted_count ?? 0,
        dismissedInsights: r.dismissed_count ?? 0,
        byCategory,
      };
    });
  } finally {
    client.release();
  }
}

export async function updateInsightStatus(
  tenantId: string,
  insightId: string,
  status: 'accepted' | 'dismissed',
  userId?: string,
): Promise<AiInsight | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    return await withTenantContext(client, tenantId, async () => {
      if (status === 'accepted') {
        const { rows } = await client.query(
          `UPDATE ai_insights SET status = $1, updated_at = NOW(), accepted_at = NOW(), accepted_by = $4
           WHERE id = $2 AND tenant_id = $3
           RETURNING *`,
          [status, insightId, tenantId, userId || null],
        );
        return rows[0] ? mapInsightRow(rows[0]) : null;
      } else {
        const { rows } = await client.query(
          `UPDATE ai_insights SET status = $1, updated_at = NOW(), dismissed_at = NOW()
           WHERE id = $2 AND tenant_id = $3
           RETURNING *`,
          [status, insightId, tenantId],
        );
        return rows[0] ? mapInsightRow(rows[0]) : null;
      }
    });
  } finally {
    client.release();
  }
}

export async function generateWeeklyReport(tenantId: string): Promise<WeeklyReport | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping weekly report');
    return null;
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);
    const weekStartDate = weekStart.toISOString().slice(0, 10);
    const weekEndDate = now.toISOString().slice(0, 10);

    const { rows: existing } = await client.query(
      `SELECT id FROM weekly_reports WHERE tenant_id = $1 AND week_start = $2`,
      [tenantId, weekStartDate],
    );
    if (existing.length > 0) {
      const { rows } = await client.query(
        `SELECT * FROM weekly_reports WHERE id = $1 AND tenant_id = $2`,
        [existing[0].id, tenantId],
      );
      await client.query('COMMIT');
      return rows[0] ? mapReportRow(rows[0]) : null;
    }

    const { rows: callStats } = await client.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::int AS failed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated,
         COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration,
         COALESCE(SUM(total_cost_cents), 0)::int AS total_cost
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, weekStart, now],
    );

    const { rows: prevCallStats } = await client.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::int AS failed,
         COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration,
         COALESCE(SUM(total_cost_cents), 0)::int AS total_cost
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000), weekStart],
    );

    const { rows: qualityStats } = await client.query(
      `SELECT COALESCE(AVG(score), 0)::float AS avg_quality, COUNT(*)::int AS scored
       FROM call_quality_scores
       WHERE tenant_id = $1 AND scored_at >= $2 AND scored_at < $3`,
      [tenantId, weekStart, now],
    );

    const { rows: insightStats } = await client.query(
      `SELECT
         COUNT(*)::int AS generated,
         COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
         COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
       FROM ai_insights
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, weekStart, now],
    );

    await client.query('COMMIT');

    const cs = callStats[0] || {};
    const pcs = prevCallStats[0] || {};
    const qs = qualityStats[0] || {};
    const is_ = insightStats[0] || {};

    const metricsSnapshot = {
      totalCalls: cs.total_calls || 0,
      completed: cs.completed || 0,
      failed: cs.failed || 0,
      escalated: cs.escalated || 0,
      avgDuration: Math.round(cs.avg_duration || 0),
      totalCost: cs.total_cost || 0,
      avgQuality: parseFloat(String(qs.avg_quality || 0)).toFixed(1),
      scoredCalls: qs.scored || 0,
      prevWeekCalls: pcs.total_calls || 0,
      prevWeekCompleted: pcs.completed || 0,
      callsChange: pcs.total_calls > 0
        ? (((cs.total_calls - pcs.total_calls) / pcs.total_calls) * 100).toFixed(1)
        : '0',
    };

    const reportData = JSON.stringify(metricsSnapshot);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a weekly operations report writer for a voice AI platform. Given the metrics, write a concise weekly summary. Return ONLY valid JSON:
{
  "summary": "<3-4 sentence executive summary>",
  "top_issues": [{"title": "<issue>", "description": "<detail>", "severity": "high|medium|low"}],
  "prioritized_actions": [{"title": "<action>", "description": "<detail>", "priority": 1, "effort": "easy|medium|hard"}]
}`,
          },
          { role: 'user', content: `Weekly metrics for ${weekStartDate} to ${weekEndDate}:\n${reportData}` },
        ],
        temperature: 0.3,
        max_tokens: 1000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error during weekly report', { status: response.status, tenantId });
      return null;
    }

    const llmData = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = llmData.choices?.[0]?.message?.content;
    if (!content) return null;

    let report: Record<string, unknown>;
    try {
      report = JSON.parse(content);
    } catch {
      logger.error('Failed to parse weekly report JSON', { tenantId });
      return null;
    }

    const insertClient = await pool.connect();
    try {
      const inserted = await withTenantContext(insertClient, tenantId, async () => {
        const { rows } = await insertClient.query(
          `INSERT INTO weekly_reports (
            tenant_id, week_start, week_end, summary, metrics_snapshot,
            top_issues, prioritized_actions, insights_generated, insights_accepted, insights_dismissed
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (tenant_id, week_start) DO UPDATE SET
            summary = EXCLUDED.summary, metrics_snapshot = EXCLUDED.metrics_snapshot,
            top_issues = EXCLUDED.top_issues, prioritized_actions = EXCLUDED.prioritized_actions
          RETURNING *`,
          [
            tenantId,
            weekStartDate,
            weekEndDate,
            String(report.summary || 'Weekly report generated.'),
            JSON.stringify(metricsSnapshot),
            JSON.stringify(report.top_issues || []),
            JSON.stringify(report.prioritized_actions || []),
            is_.generated || 0,
            is_.accepted || 0,
            is_.dismissed || 0,
          ],
        );
        return rows;
      });

      logger.info('Weekly report generated', { tenantId, weekStart: weekStartDate });
      return inserted[0] ? mapReportRow(inserted[0]) : null;
    } finally {
      insertClient.release();
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Weekly report generation failed', { tenantId, error: String(err) });
    return null;
  } finally {
    client.release();
  }
}

export async function getWeeklyReports(
  tenantId: string,
  limit: number = 12,
): Promise<WeeklyReport[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    return await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM weekly_reports WHERE tenant_id = $1 ORDER BY week_start DESC LIMIT $2`,
        [tenantId, limit],
      );
      return rows.map(mapReportRow);
    });
  } finally {
    client.release();
  }
}

export async function detectAnomalies(tenantId: string): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const baselineStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { rows: currentMetrics } = await client.query(
      `SELECT
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::int AS failed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, oneHourAgo, now],
    );

    const { rows: baselineMetrics } = await client.query(
      `SELECT
         COUNT(*)::float / GREATEST(EXTRACT(EPOCH FROM ($3::timestamptz - $2::timestamptz)) / 3600, 1) AS avg_calls_per_hour,
         CASE WHEN COUNT(*) > 0 THEN
           COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::float / COUNT(*)
         ELSE 0 END AS completion_rate,
         CASE WHEN COUNT(*) > 0 THEN
           COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::float / COUNT(*)
         ELSE 0 END AS failure_rate,
         CASE WHEN COUNT(*) > 0 THEN
           COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::float / COUNT(*)
         ELSE 0 END AS escalation_rate
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, baselineStart, oneHourAgo],
    );

    await client.query('COMMIT');

    const current = currentMetrics[0] || {};
    const baseline = baselineMetrics[0] || {};

    const currentCalls = current.calls || 0;
    const baselineAvg = parseFloat(String(baseline.avg_calls_per_hour || 0));

    if (currentCalls < 3) return;

    const alerts: Array<{ type: string; severity: string; message: string; metadata: Record<string, unknown> }> = [];

    if (baselineAvg > 2) {
      const currentCompletionRate = currentCalls > 0 ? (current.completed || 0) / currentCalls : 0;
      const baselineCompletionRate = parseFloat(String(baseline.completion_rate || 0));

      if (baselineCompletionRate > 0.5 && currentCompletionRate < baselineCompletionRate * 0.7) {
        alerts.push({
          type: 'booking_rate_drop',
          severity: 'warning',
          message: `Completion rate dropped to ${(currentCompletionRate * 100).toFixed(0)}% (baseline: ${(baselineCompletionRate * 100).toFixed(0)}%) in the last hour`,
          metadata: { currentRate: currentCompletionRate, baselineRate: baselineCompletionRate },
        });
      }

      const currentEscalationRate = currentCalls > 0 ? (current.escalated || 0) / currentCalls : 0;
      const baselineEscalationRate = parseFloat(String(baseline.escalation_rate || 0));

      if (currentEscalationRate > baselineEscalationRate * 2 && currentEscalationRate > 0.15) {
        alerts.push({
          type: 'escalation_spike',
          severity: 'warning',
          message: `Escalation rate spiked to ${(currentEscalationRate * 100).toFixed(0)}% (baseline: ${(baselineEscalationRate * 100).toFixed(0)}%) in the last hour`,
          metadata: { currentRate: currentEscalationRate, baselineRate: baselineEscalationRate },
        });
      }

      const currentFailureRate = currentCalls > 0 ? (current.failed || 0) / currentCalls : 0;
      const baselineFailureRate = parseFloat(String(baseline.failure_rate || 0));

      if (currentFailureRate > baselineFailureRate * 2 && currentFailureRate > 0.1) {
        alerts.push({
          type: 'error_rate_spike',
          severity: 'critical',
          message: `Failure rate spiked to ${(currentFailureRate * 100).toFixed(0)}% (baseline: ${(baselineFailureRate * 100).toFixed(0)}%) in the last hour`,
          metadata: { currentRate: currentFailureRate, baselineRate: baselineFailureRate },
        });
      }
    }

    if (alerts.length > 0) {
      const alertClient = await pool.connect();
      try {
        await withTenantContext(alertClient, tenantId, async () => {
          for (const alert of alerts) {
            const { rows: recentDupes } = await alertClient.query(
              `SELECT id FROM operations_alerts
               WHERE tenant_id = $1 AND type = $2 AND created_at > NOW() - INTERVAL '2 hours'
               LIMIT 1`,
              [tenantId, alert.type],
            );
            if (recentDupes.length === 0) {
              await alertClient.query(
                `INSERT INTO operations_alerts (tenant_id, type, severity, message, metadata)
                 VALUES ($1, $2, $3, $4, $5)`,
                [tenantId, alert.type, alert.severity, alert.message, JSON.stringify(alert.metadata)],
              );
              logger.info('Anomaly alert created', { tenantId, type: alert.type, severity: alert.severity });
            }
          }
        });
      } finally {
        alertClient.release();
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Anomaly detection failed', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function getAlertHistory(
  tenantId: string,
  options: { limit?: number; offset?: number; severity?: string } = {},
): Promise<{ alerts: OperationsAlert[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  try {
    return await withTenantContext(client, tenantId, async () => {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let paramIdx = 2;

      if (options.severity) {
        conditions.push(`severity = $${paramIdx}`);
        params.push(options.severity);
        paramIdx++;
      }

      const where = conditions.join(' AND ');

      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM operations_alerts WHERE ${where}`,
        params,
      );

      const { rows } = await client.query(
        `SELECT * FROM operations_alerts WHERE ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      );

      return {
        alerts: rows.map(mapAlertRow),
        total: countRows[0]?.total ?? 0,
      };
    });
  } finally {
    client.release();
  }
}

export async function acknowledgeAlert(
  tenantId: string,
  alertId: string,
): Promise<boolean> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    return await withTenantContext(client, tenantId, async () => {
      const { rowCount } = await client.query(
        `UPDATE operations_alerts SET acknowledged = true
         WHERE id = $1 AND tenant_id = $2`,
        [alertId, tenantId],
      );
      return (rowCount ?? 0) > 0;
    });
  } finally {
    client.release();
  }
}

export async function measureInsightImpact(tenantId: string): Promise<number> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  let updatedCount = 0;

  try {
    const acceptedInsights = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT id, category, accepted_at, action_type, action_payload,
                analysis_period_start, analysis_period_end
         FROM ai_insights
         WHERE tenant_id = $1 AND status = 'accepted' AND measured_impact IS NULL
           AND accepted_at < NOW() - INTERVAL '3 days'
         LIMIT 20`,
        [tenantId],
      );
      return rows;
    });

    if (acceptedInsights.length === 0) return 0;

    for (const insight of acceptedInsights) {
      try {
        const acceptedAt = new Date(insight.accepted_at as string);
        const preStart = new Date(acceptedAt.getTime() - 7 * 24 * 60 * 60 * 1000);
        const postEnd = new Date();

        const measureClient = await pool.connect();
        try {
          const impact = await withTenantContext(measureClient, tenantId, async () => {
            const { rows: preMetrics } = await measureClient.query(
              `SELECT
                 COUNT(*)::int AS calls,
                 COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::float / GREATEST(COUNT(*), 1) AS completion_rate,
                 COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::float / GREATEST(COUNT(*), 1) AS failure_rate,
                 COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration,
                 COALESCE(SUM(total_cost_cents), 0)::int AS total_cost
               FROM call_sessions
               WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
              [tenantId, preStart, acceptedAt],
            );

            const { rows: postMetrics } = await measureClient.query(
              `SELECT
                 COUNT(*)::int AS calls,
                 COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::float / GREATEST(COUNT(*), 1) AS completion_rate,
                 COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::float / GREATEST(COUNT(*), 1) AS failure_rate,
                 COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration,
                 COALESCE(SUM(total_cost_cents), 0)::int AS total_cost
               FROM call_sessions
               WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
              [tenantId, acceptedAt, postEnd],
            );

            const pre = preMetrics[0] || {};
            const post = postMetrics[0] || {};

            const measuredImpact: Record<string, unknown> = {
              preAcceptance: {
                calls: pre.calls ?? 0,
                completionRate: parseFloat(String(pre.completion_rate ?? 0)),
                failureRate: parseFloat(String(pre.failure_rate ?? 0)),
                avgDuration: parseFloat(String(pre.avg_duration ?? 0)),
                totalCost: pre.total_cost ?? 0,
              },
              postAcceptance: {
                calls: post.calls ?? 0,
                completionRate: parseFloat(String(post.completion_rate ?? 0)),
                failureRate: parseFloat(String(post.failure_rate ?? 0)),
                avgDuration: parseFloat(String(post.avg_duration ?? 0)),
                totalCost: post.total_cost ?? 0,
              },
              completionRateChange: parseFloat(String(post.completion_rate ?? 0)) - parseFloat(String(pre.completion_rate ?? 0)),
              failureRateChange: parseFloat(String(post.failure_rate ?? 0)) - parseFloat(String(pre.failure_rate ?? 0)),
              measuredAt: new Date().toISOString(),
            };

            await measureClient.query(
              `UPDATE ai_insights SET measured_impact = $1, updated_at = NOW()
               WHERE id = $2 AND tenant_id = $3`,
              [JSON.stringify(measuredImpact), insight.id, tenantId],
            );

            return measuredImpact;
          });

          if (impact) updatedCount++;
        } finally {
          measureClient.release();
        }
      } catch (err) {
        logger.error('Failed to measure impact for insight', {
          tenantId,
          insightId: insight.id as string,
          error: String(err),
        });
      }
    }

    logger.info('Impact measurement completed', { tenantId, updatedCount });
    return updatedCount;
  } finally {
    client.release();
  }
}

export interface OperationsAlert {
  id: string;
  tenantId: string;
  type: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown>;
  acknowledged: boolean;
  createdAt: string;
}

function mapInsightRow(row: Record<string, unknown>): AiInsight {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    category: row.category as string,
    title: row.title as string,
    description: row.description as string,
    impactEstimate: row.impact_estimate as string | null,
    difficulty: row.difficulty as string,
    estimatedRevenueImpactCents: row.estimated_revenue_impact_cents as number | null,
    status: row.status as string,
    actionType: row.action_type as string | null,
    actionPayload: (row.action_payload as Record<string, unknown>) || {},
    metadata: (row.metadata as Record<string, unknown>) || {},
    measuredImpact: row.measured_impact as Record<string, unknown> | null,
    analysisPeriodStart: row.analysis_period_start ? String(row.analysis_period_start) : null,
    analysisPeriodEnd: row.analysis_period_end ? String(row.analysis_period_end) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAlertRow(row: Record<string, unknown>): OperationsAlert {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    type: row.type as string,
    severity: row.severity as string,
    message: row.message as string,
    metadata: (row.metadata as Record<string, unknown>) || {},
    acknowledged: row.acknowledged as boolean,
    createdAt: String(row.created_at),
  };
}

function mapReportRow(row: Record<string, unknown>): WeeklyReport {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    weekStart: String(row.week_start).slice(0, 10),
    weekEnd: String(row.week_end).slice(0, 10),
    summary: row.summary as string,
    metricsSnapshot: (row.metrics_snapshot as Record<string, unknown>) || {},
    topIssues: (row.top_issues as Array<Record<string, unknown>>) || [],
    prioritizedActions: (row.prioritized_actions as Array<Record<string, unknown>>) || [],
    insightsGenerated: (row.insights_generated as number) || 0,
    insightsAccepted: (row.insights_accepted as number) || 0,
    insightsDismissed: (row.insights_dismissed as number) || 0,
    createdAt: String(row.created_at),
  };
}
