import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type {
  AutopilotInsight,
  AutopilotRecommendation,
  AutopilotRun,
  OperationalSignals,
  IndustryDetectionRule,
  DetectionResult,
} from './types';
import { getIndustryPackRules } from './industry-packs';
import { createInAppNotification } from './NotificationService';

const logger = createLogger('AUTOPILOT_ENGINE');

const ANALYSIS_PROMPT = `You are an AI business operations analyst for a voice AI platform. Analyze the operational signals and generate actionable insights and recommendations.

For each finding, provide:
1. title - Clear, specific title
2. situation_summary - What was detected and the data behind it
3. recommended_action - Specific action to take
4. expected_outcome - What improvement to expect
5. reasoning - Transparent explanation of why this action is recommended
6. confidence_score - 0.0 to 1.0 confidence in this recommendation
7. risk_tier - "low", "medium", or "high"
8. category - One of: missed_calls, booking_conversion, unanswered_questions, after_hours, scheduling, agent_utilization, campaign_effectiveness, cost_optimization, quality
9. severity - "info", "warning", or "critical"
10. action_type - One of: enable_workflow, disable_workflow, activate_agent, launch_campaign, update_routing, create_task, adjust_schedule, send_alert
11. action_payload - JSON object with action-specific parameters
12. estimated_revenue_impact_cents - Estimated monthly revenue impact (integer, or null)
13. estimated_cost_savings_cents - Estimated monthly cost savings (integer, or null)

Return ONLY a valid JSON object with key "recommendations" containing an array of findings.`;

function mapInsightRow(r: Record<string, unknown>): AutopilotInsight {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    runId: (r.run_id as string) || null,
    category: r.category as string,
    severity: r.severity as AutopilotInsight['severity'],
    title: r.title as string,
    description: r.description as string,
    detectedSignal: r.detected_signal as string,
    dataEvidence: (r.data_evidence as Record<string, unknown>) || {},
    industryPack: (r.industry_pack as string) || null,
    confidenceScore: parseFloat(String(r.confidence_score ?? 0.5)),
    status: r.status as string,
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
    metadata: (r.metadata as Record<string, unknown>) || {},
    analysisPeriodStart: r.analysis_period_start ? String(r.analysis_period_start) : null,
    analysisPeriodEnd: r.analysis_period_end ? String(r.analysis_period_end) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapRecommendationRow(r: Record<string, unknown>): AutopilotRecommendation {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    insightId: (r.insight_id as string) || null,
    runId: (r.run_id as string) || null,
    title: r.title as string,
    situationSummary: r.situation_summary as string,
    recommendedAction: r.recommended_action as string,
    expectedOutcome: r.expected_outcome as string,
    reasoning: r.reasoning as string,
    confidenceScore: parseFloat(String(r.confidence_score ?? 0.5)),
    riskTier: r.risk_tier as AutopilotRecommendation['riskTier'],
    actionType: r.action_type as string,
    actionPayload: (r.action_payload as Record<string, unknown>) || {},
    estimatedRevenueImpactCents: r.estimated_revenue_impact_cents != null ? Number(r.estimated_revenue_impact_cents) : null,
    estimatedCostSavingsCents: r.estimated_cost_savings_cents != null ? Number(r.estimated_cost_savings_cents) : null,
    status: r.status as AutopilotRecommendation['status'],
    approvedBy: (r.approved_by as string) || null,
    approvedAt: r.approved_at ? String(r.approved_at) : null,
    rejectedBy: (r.rejected_by as string) || null,
    rejectedAt: r.rejected_at ? String(r.rejected_at) : null,
    rejectionReason: (r.rejection_reason as string) || null,
    dismissedBy: (r.dismissed_by as string) || null,
    dismissedAt: r.dismissed_at ? String(r.dismissed_at) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    industryPack: (r.industry_pack as string) || null,
    metadata: (r.metadata as Record<string, unknown>) || {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapRunRow(r: Record<string, unknown>): AutopilotRun {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    runType: r.run_type as string,
    status: r.status as string,
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    insightsDetected: Number(r.insights_detected ?? 0),
    recommendationsGenerated: Number(r.recommendations_generated ?? 0),
    actionsAutoExecuted: Number(r.actions_auto_executed ?? 0),
    errors: Number(r.errors ?? 0),
    metadata: (r.metadata as Record<string, unknown>) || {},
    createdAt: String(r.created_at),
  };
}

async function gatherOperationalSignals(tenantId: string): Promise<OperationalSignals> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const { rows: callRows } = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE lifecycle_state IN ('CALL_FAILED','WORKFLOW_FAILED'))::int AS failed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated,
         COUNT(*) FILTER (WHERE lifecycle_state = 'MISSED' OR (direction = 'inbound' AND duration_seconds < 5 AND lifecycle_state != 'CALL_COMPLETED'))::int AS missed
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: prevCallRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, fourteenDaysAgo, sevenDaysAgo],
    );

    const { rows: hourlyRows } = await client.query(
      `SELECT
         EXTRACT(HOUR FROM created_at)::int AS hour,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'MISSED' OR (direction = 'inbound' AND duration_seconds < 5 AND lifecycle_state != 'CALL_COMPLETED'))::int AS missed
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY EXTRACT(HOUR FROM created_at)
       ORDER BY hour`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: agentRows } = await client.query(
      `SELECT
         a.id AS agent_id, a.name AS agent_name,
         COUNT(cs.id)::int AS calls,
         COALESCE(AVG(cs.duration_seconds) FILTER (WHERE cs.duration_seconds > 0), 0)::float AS avg_duration,
         COUNT(cs.id) FILTER (WHERE cs.lifecycle_state = 'ESCALATED')::int AS escalated,
         COUNT(cs.id) FILTER (WHERE cs.lifecycle_state IN ('CALL_FAILED','WORKFLOW_FAILED'))::int AS failed
       FROM agents a
       LEFT JOIN call_sessions cs ON cs.agent_id = a.id AND cs.created_at >= $2 AND cs.created_at < $3
       WHERE a.tenant_id = $1
       GROUP BY a.id, a.name`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: toolRows } = await client.query(
      `SELECT
         COALESCE((payload->>'tool')::text, 'unknown') AS tool,
         COUNT(*) FILTER (WHERE event_type = 'TOOL_START')::int AS total,
         COUNT(*) FILTER (WHERE event_type = 'TOOL_END')::int AS completed
       FROM call_events
       WHERE tenant_id = $1 AND event_type IN ('TOOL_START', 'TOOL_END')
         AND occurred_at >= $2 AND occurred_at < $3
       GROUP BY (payload->>'tool')`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: afterHoursRows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
         AND (EXTRACT(HOUR FROM created_at) < 8 OR EXTRACT(HOUR FROM created_at) >= 18)`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: campaignRows } = await client.query(
      `SELECT
         c.id AS campaign_id, c.name,
         COUNT(cc.id)::int AS contacted,
         COUNT(cc.id) FILTER (WHERE cc.status = 'completed')::int AS converted,
         COUNT(cc.id) FILTER (WHERE cc.status = 'failed')::int AS failed
       FROM campaigns c
       LEFT JOIN campaign_contacts cc ON cc.campaign_id = c.id
       WHERE c.tenant_id = $1 AND c.status IN ('active', 'completed')
         AND c.created_at >= $2 AND c.created_at < $3
       GROUP BY c.id, c.name`,
      [tenantId, sevenDaysAgo, now],
    );

    let bookingTotal = 0, bookingConverted = 0, bookingCancelled = 0, bookingNoShow = 0;
    try {
      const { rows: bookingRows } = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_type = 'TOOL_END' AND payload->>'tool' ILIKE '%book%')::int AS total,
           COUNT(*) FILTER (WHERE event_type = 'TOOL_END' AND payload->>'tool' ILIKE '%book%' AND payload->>'status' = 'success')::int AS converted,
           COUNT(*) FILTER (WHERE event_type = 'TOOL_END' AND payload->>'tool' ILIKE '%cancel%')::int AS cancelled
         FROM call_events
         WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at < $3
           AND event_type = 'TOOL_END'`,
        [tenantId, sevenDaysAgo, now],
      );
      if (bookingRows[0]) {
        bookingTotal = Number(bookingRows[0].total || 0);
        bookingConverted = Number(bookingRows[0].converted || 0);
        bookingCancelled = Number(bookingRows[0].cancelled || 0);
      }
    } catch { /* table/column may not exist yet */ }

    let sentimentAvg = 0;
    try {
      const { rows: sentimentRows } = await client.query(
        `SELECT COALESCE(AVG(
           CASE WHEN (metrics->>'customer_sentiment')::text IS NOT NULL
                THEN (metrics->>'customer_sentiment')::float ELSE NULL END
         ), 0)::float AS avg_sentiment
         FROM call_sessions
         WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
           AND metrics IS NOT NULL`,
        [tenantId, sevenDaysAgo, now],
      );
      sentimentAvg = Number(sentimentRows[0]?.avg_sentiment || 0);
    } catch { /* metrics column may vary */ }

    let repeatCallers = 0;
    try {
      const { rows: repeatRows } = await client.query(
        `SELECT COUNT(*)::int AS repeat_callers FROM (
           SELECT caller_number FROM call_sessions
           WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
             AND caller_number IS NOT NULL
           GROUP BY caller_number HAVING COUNT(*) > 1
         ) sub`,
        [tenantId, sevenDaysAgo, now],
      );
      repeatCallers = Number(repeatRows[0]?.repeat_callers || 0);
    } catch { /* column may not exist */ }

    let avgWaitTime = 0;
    try {
      const { rows: waitRows } = await client.query(
        `SELECT COALESCE(AVG(
           CASE WHEN (metrics->>'wait_time_seconds')::text IS NOT NULL
                THEN (metrics->>'wait_time_seconds')::float ELSE NULL END
         ), 0)::float AS avg_wait
         FROM call_sessions
         WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
        [tenantId, sevenDaysAgo, now],
      );
      avgWaitTime = Math.round(Number(waitRows[0]?.avg_wait || 0));
    } catch { /* column may vary */ }

    const { rows: tenantRows } = await client.query(
      `SELECT settings FROM tenants WHERE id = $1`,
      [tenantId],
    );

    await client.query('COMMIT');

    const cv = callRows[0] || {};
    const settings = (tenantRows[0]?.settings as Record<string, unknown>) || {};
    const industry = (settings.industry as string) || null;

    return {
      tenantId,
      industry,
      callVolume: {
        total: cv.total || 0,
        missed: cv.missed || 0,
        completed: cv.completed || 0,
        failed: cv.failed || 0,
        escalated: cv.escalated || 0,
      },
      bookingMetrics: { total: bookingTotal, converted: bookingConverted, cancelled: bookingCancelled, noShow: bookingNoShow },
      sentimentAvg,
      hourlyCallPattern: hourlyRows.map((h: Record<string, unknown>) => ({
        hour: Number(h.hour),
        calls: Number(h.calls),
        missed: Number(h.missed),
      })),
      agentMetrics: agentRows.map((a: Record<string, unknown>) => ({
        agentId: String(a.agent_id),
        agentName: String(a.agent_name),
        calls: Number(a.calls),
        avgDuration: Math.round(Number(a.avg_duration)),
        escalated: Number(a.escalated),
        failed: Number(a.failed),
      })),
      toolFailures: toolRows.map((t: Record<string, unknown>) => ({
        tool: String(t.tool),
        failures: Math.max(0, Number(t.total) - Number(t.completed)),
        total: Number(t.total),
      })),
      campaignMetrics: campaignRows.map((c: Record<string, unknown>) => ({
        campaignId: String(c.campaign_id),
        name: String(c.name),
        contacted: Number(c.contacted),
        converted: Number(c.converted),
        failed: Number(c.failed),
      })),
      afterHoursCalls: Number(afterHoursRows[0]?.count || 0),
      repeatCallers,
      avgWaitTime,
      previousPeriodCallVolume: Number(prevCallRows[0]?.total || 0),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function runAutopilotScan(
  tenantId: string,
  runType: 'scheduled' | 'manual' = 'scheduled',
): Promise<{ run: AutopilotRun; insights: AutopilotInsight[]; recommendations: AutopilotRecommendation[] }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  let runId: string;
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows: runRows } = await client.query(
      `INSERT INTO autopilot_runs (tenant_id, run_type, status)
       VALUES ($1, $2, 'running') RETURNING *`,
      [tenantId, runType],
    );
    runId = runRows[0].id as string;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const allInsights: AutopilotInsight[] = [];
  const allRecommendations: AutopilotRecommendation[] = [];
  let errorCount = 0;

  try {
    const signals = await gatherOperationalSignals(tenantId);

    if (signals.callVolume.total < 1) {
      logger.info('Not enough data for autopilot scan', { tenantId });
      await finalizeRun(tenantId, runId, 'completed', 0, 0, 0, 0);
      const run = await getRunById(tenantId, runId);
      return { run: run!, insights: [], recommendations: [] };
    }

    const industryRules = getIndustryPackRules(signals.industry);
    for (const rule of industryRules) {
      try {
        const result = rule.evaluate(signals);
        if (result) {
          const { insight, recommendation } = await storeDetection(
            tenantId, runId, rule, result, signals,
          );
          allInsights.push(insight);
          allRecommendations.push(recommendation);
        }
      } catch (err) {
        logger.error('Industry rule evaluation failed', { tenantId, ruleId: rule.id, error: String(err) });
        errorCount++;
      }
    }

    try {
      const llmResults = await runLlmAnalysis(signals);
      for (const result of llmResults) {
        const { insight, recommendation } = await storeDetectionFromLlm(tenantId, runId, result, signals);
        allInsights.push(insight);
        allRecommendations.push(recommendation);
      }
    } catch (err) {
      logger.error('LLM analysis failed', { tenantId, error: String(err) });
      errorCount++;
    }

    let autoExecCount = 0;
    for (const rec of allRecommendations) {
      try {
        await createInAppNotification(tenantId, {
          recommendationId: rec.id,
          severity: rec.riskTier === 'high' ? 'critical' : rec.riskTier === 'medium' ? 'warning' : 'info',
          title: `New recommendation: ${rec.title}`,
          body: rec.situationSummary,
        });
      } catch (err) {
        logger.error('Failed to create notification for recommendation', { tenantId, recId: rec.id, error: String(err) });
      }

      if (rec.riskTier === 'low') {
        try {
          const shouldAutoExec = await shouldAutoExecute(tenantId, rec.actionType, rec.riskTier);
          if (shouldAutoExec) {
            await autoApproveRecommendation(tenantId, rec.id);
            const { executeAction } = await import('./ActionEngine');
            const action = await executeAction(tenantId, rec.id, undefined, true);
            if (action && action.status === 'completed') {
              autoExecCount++;
              logger.info('Auto-executed low-risk action', { tenantId, recId: rec.id, actionType: rec.actionType });
            }
          }
        } catch (err) {
          logger.error('Auto-execution failed', { tenantId, recId: rec.id, error: String(err) });
          errorCount++;
        }
      }

      if (rec.riskTier === 'high') {
        try {
          await notifyHighRiskRecommendation(tenantId, rec);
        } catch (err) {
          logger.error('Failed to send high-risk notification', { tenantId, recId: rec.id, error: String(err) });
        }
      }
    }

    await finalizeRun(tenantId, runId, 'completed', allInsights.length, allRecommendations.length, autoExecCount, errorCount);
  } catch (err) {
    logger.error('Autopilot scan failed', { tenantId, error: String(err) });
    await finalizeRun(tenantId, runId, 'failed', allInsights.length, allRecommendations.length, 0, errorCount + 1);
  }

  const run = await getRunById(tenantId, runId);
  return { run: run!, insights: allInsights, recommendations: allRecommendations };
}

async function storeDetection(
  tenantId: string,
  runId: string,
  rule: IndustryDetectionRule,
  result: DetectionResult,
  signals: OperationalSignals,
): Promise<{ insight: AutopilotInsight; recommendation: AutopilotRecommendation }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { rows: insightRows } = await client.query(
      `INSERT INTO autopilot_insights (
        tenant_id, run_id, category, severity, title, description,
        detected_signal, data_evidence, industry_pack, confidence_score,
        analysis_period_start, analysis_period_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        tenantId, runId, rule.category, rule.severity,
        result.title, result.description, result.detectedSignal,
        JSON.stringify(result.dataEvidence), rule.vertical,
        result.confidenceScore, sevenDaysAgo, now,
      ],
    );

    const { rows: recRows } = await client.query(
      `INSERT INTO autopilot_recommendations (
        tenant_id, insight_id, run_id, title, situation_summary,
        recommended_action, expected_outcome, reasoning, confidence_score,
        risk_tier, action_type, action_payload, estimated_revenue_impact_cents,
        estimated_cost_savings_cents, industry_pack,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW() + INTERVAL '7 days')
      RETURNING *`,
      [
        tenantId, insightRows[0].id, runId, result.title,
        result.description, result.recommendedAction, result.expectedOutcome,
        result.reasoning, result.confidenceScore, rule.riskTier,
        result.actionType, JSON.stringify(result.actionPayload),
        result.estimatedRevenueImpactCents ?? null,
        result.estimatedCostSavingsCents ?? null,
        rule.vertical,
      ],
    );

    await client.query('COMMIT');

    return {
      insight: mapInsightRow(insightRows[0]),
      recommendation: mapRecommendationRow(recRows[0]),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function storeDetectionFromLlm(
  tenantId: string,
  runId: string,
  result: Record<string, unknown>,
  _signals: OperationalSignals,
): Promise<{ insight: AutopilotInsight; recommendation: AutopilotRecommendation }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const category = String(result.category || 'general');
    const severity = String(result.severity || 'info');
    const title = String(result.title || 'Detected Issue');
    const situationSummary = String(result.situation_summary || '');
    const recommendedAction = String(result.recommended_action || '');
    const expectedOutcome = String(result.expected_outcome || '');
    const reasoning = String(result.reasoning || '');
    const confidenceScore = typeof result.confidence_score === 'number' ? result.confidence_score : 0.5;
    const riskTier = String(result.risk_tier || 'medium');
    const actionType = String(result.action_type || 'send_alert');

    const { rows: insightRows } = await client.query(
      `INSERT INTO autopilot_insights (
        tenant_id, run_id, category, severity, title, description,
        detected_signal, data_evidence, confidence_score,
        analysis_period_start, analysis_period_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        tenantId, runId, category, severity, title, situationSummary,
        recommendedAction, JSON.stringify(result),
        confidenceScore, sevenDaysAgo, now,
      ],
    );

    const { rows: recRows } = await client.query(
      `INSERT INTO autopilot_recommendations (
        tenant_id, insight_id, run_id, title, situation_summary,
        recommended_action, expected_outcome, reasoning, confidence_score,
        risk_tier, action_type, action_payload, estimated_revenue_impact_cents,
        estimated_cost_savings_cents,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW() + INTERVAL '7 days')
      RETURNING *`,
      [
        tenantId, insightRows[0].id, runId, title, situationSummary,
        recommendedAction, expectedOutcome, reasoning, confidenceScore,
        riskTier, actionType, JSON.stringify(result.action_payload || {}),
        typeof result.estimated_revenue_impact_cents === 'number' ? result.estimated_revenue_impact_cents : null,
        typeof result.estimated_cost_savings_cents === 'number' ? result.estimated_cost_savings_cents : null,
      ],
    );

    await client.query('COMMIT');
    return {
      insight: mapInsightRow(insightRows[0]),
      recommendation: mapRecommendationRow(recRows[0]),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function runLlmAnalysis(signals: OperationalSignals): Promise<Array<Record<string, unknown>>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping LLM autopilot analysis');
    return [];
  }

  const signalData = JSON.stringify({
    callVolume: signals.callVolume,
    hourlyPattern: signals.hourlyCallPattern,
    agentPerformance: signals.agentMetrics,
    toolFailures: signals.toolFailures,
    afterHoursCalls: signals.afterHoursCalls,
    previousPeriodCallVolume: signals.previousPeriodCallVolume,
    industry: signals.industry,
  });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: `Analyze these operational signals and generate business autopilot recommendations:\n\n${signalData}` },
      ],
      temperature: 0.3,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    logger.error('OpenAI API error during autopilot analysis', { status: response.status });
    return [];
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    const recs = Array.isArray(parsed) ? parsed : (parsed.recommendations || []);
    return recs.slice(0, 10);
  } catch {
    logger.error('Failed to parse LLM autopilot response');
    return [];
  }
}

async function finalizeRun(
  tenantId: string, runId: string, status: string,
  insights: number, recommendations: number, autoExecuted: number, errors: number,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    await client.query(
      `UPDATE autopilot_runs SET status = $1, completed_at = NOW(),
       insights_detected = $2, recommendations_generated = $3,
       actions_auto_executed = $4, errors = $5
       WHERE id = $6 AND tenant_id = $7`,
      [status, insights, recommendations, autoExecuted, errors, runId, tenantId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to finalize run', { runId, error: String(err) });
  } finally {
    client.release();
  }
}

async function getRunById(tenantId: string, runId: string): Promise<AutopilotRun | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT * FROM autopilot_runs WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    await client.query('COMMIT');
    return rows[0] ? mapRunRow(rows[0]) : null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return null;
  } finally {
    client.release();
  }
}

export async function getAutopilotInsights(
  tenantId: string,
  options: { status?: string; severity?: string; category?: string; limit?: number; offset?: number } = {},
): Promise<{ insights: AutopilotInsight[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  try {
    await client.query('BEGIN');
    return await withTenantContext(client, tenantId, async () => {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (options.status) { conditions.push(`status = $${idx++}`); params.push(options.status); }
      if (options.severity) { conditions.push(`severity = $${idx++}`); params.push(options.severity); }
      if (options.category) { conditions.push(`category = $${idx++}`); params.push(options.category); }

      const where = conditions.join(' AND ');
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM autopilot_insights WHERE ${where}`, params,
      );
      const { rows } = await client.query(
        `SELECT * FROM autopilot_insights WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      );
      await client.query('COMMIT');
      return { insights: rows.map(mapInsightRow), total: countRows[0]?.total ?? 0 };
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getAutopilotRecommendations(
  tenantId: string,
  options: { status?: string; riskTier?: string; limit?: number; offset?: number } = {},
): Promise<{ recommendations: AutopilotRecommendation[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  try {
    await client.query('BEGIN');
    return await withTenantContext(client, tenantId, async () => {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (options.status) { conditions.push(`status = $${idx++}`); params.push(options.status); }
      if (options.riskTier) { conditions.push(`risk_tier = $${idx++}`); params.push(options.riskTier); }

      const where = conditions.join(' AND ');
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM autopilot_recommendations WHERE ${where}`, params,
      );
      const { rows } = await client.query(
        `SELECT * FROM autopilot_recommendations WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      );
      await client.query('COMMIT');
      return { recommendations: rows.map(mapRecommendationRow), total: countRows[0]?.total ?? 0 };
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getAutopilotRuns(
  tenantId: string,
  limit: number = 20,
): Promise<AutopilotRun[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM autopilot_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [tenantId, Math.min(limit, 100)],
      );
      await client.query('COMMIT');
      return rows.map(mapRunRow);
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return [];
  } finally {
    client.release();
  }
}

export async function getAutopilotDashboardSummary(tenantId: string): Promise<{
  totalInsights: number;
  activeInsights: number;
  totalRecommendations: number;
  pendingRecommendations: number;
  approvedRecommendations: number;
  rejectedRecommendations: number;
  executedActions: number;
  totalRevenueImpactCents: number;
  totalCostSavingsCents: number;
  lastRunAt: string | null;
}> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await withTenantContext(client, tenantId, async () => {
      const { rows: insightStats } = await client.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active
         FROM autopilot_insights WHERE tenant_id = $1`,
        [tenantId],
      );

      const { rows: recStats } = await client.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
           COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
           COALESCE(SUM(estimated_revenue_impact_cents) FILTER (WHERE status IN ('approved','executed')), 0)::int AS rev_impact,
           COALESCE(SUM(estimated_cost_savings_cents) FILTER (WHERE status IN ('approved','executed')), 0)::int AS cost_savings
         FROM autopilot_recommendations WHERE tenant_id = $1`,
        [tenantId],
      );

      const { rows: actionStats } = await client.query(
        `SELECT COUNT(*)::int AS executed FROM autopilot_actions
         WHERE tenant_id = $1 AND status = 'completed'`,
        [tenantId],
      );

      const { rows: lastRunRows } = await client.query(
        `SELECT started_at FROM autopilot_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      );

      await client.query('COMMIT');

      const is = insightStats[0] || {};
      const rs = recStats[0] || {};
      const as_ = actionStats[0] || {};

      return {
        totalInsights: is.total ?? 0,
        activeInsights: is.active ?? 0,
        totalRecommendations: rs.total ?? 0,
        pendingRecommendations: rs.pending ?? 0,
        approvedRecommendations: rs.approved ?? 0,
        rejectedRecommendations: rs.rejected ?? 0,
        executedActions: as_.executed ?? 0,
        totalRevenueImpactCents: rs.rev_impact ?? 0,
        totalCostSavingsCents: rs.cost_savings ?? 0,
        lastRunAt: lastRunRows[0]?.started_at ? String(lastRunRows[0].started_at) : null,
      };
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function shouldAutoExecute(tenantId: string, actionType: string, riskTier: string): Promise<boolean> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT auto_execute FROM autopilot_policies
       WHERE tenant_id = $1 AND action_type = $2 AND risk_tier = $3
         AND enabled = true AND auto_execute = true
       LIMIT 1`,
      [tenantId, actionType, riskTier],
    );
    await client.query('COMMIT');
    return rows.length > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    client.release();
  }
}

async function autoApproveRecommendation(tenantId: string, recommendationId: string): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    await client.query(
      `INSERT INTO autopilot_approvals (tenant_id, recommendation_id, action, user_id, user_role, reason)
       VALUES ($1, $2, 'approved', 'system', 'system', 'Auto-approved by policy')`,
      [tenantId, recommendationId],
    );
    await client.query(
      `UPDATE autopilot_recommendations SET status = 'approved', approved_by = 'system', approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
      [recommendationId, tenantId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Auto-approve failed', { tenantId, recommendationId, error: String(err) });
  } finally {
    client.release();
  }
}

async function notifyHighRiskRecommendation(tenantId: string, rec: AutopilotRecommendation): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: adminRows } = await client.query(
      `SELECT email, phone FROM users WHERE tenant_id = $1 AND role IN ('admin', 'owner') AND email IS NOT NULL LIMIT 3`,
      [tenantId],
    );
    await client.query('COMMIT');

    const { sendRecommendationEmail, sendUrgentSmsAlert } = await import('./NotificationService');
    for (const admin of adminRows) {
      if (admin.email) {
        try {
          await sendRecommendationEmail(tenantId, rec, admin.email as string);
        } catch (err) {
          logger.error('High-risk email notification failed', { tenantId, email: admin.email, error: String(err) });
        }
      }
      if (admin.phone) {
        try {
          await sendUrgentSmsAlert(tenantId, rec, admin.phone as string);
        } catch (err) {
          logger.error('High-risk SMS notification failed', { tenantId, error: String(err) });
        }
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to notify about high-risk recommendation', { tenantId, recId: rec.id, error: String(err) });
  } finally {
    client.release();
  }
}

export { mapInsightRow, mapRecommendationRow, mapRunRow };
