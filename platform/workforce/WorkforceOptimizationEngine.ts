import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import {
  createSimulationRun,
  executeSimulationRun,
  listScenarios,
  getSimulationResults,
} from '../simulation/SimulationEngine';
import type { WorkforceOptimizationInsight } from './types';

export interface PromptImprovementProposal {
  agentId: string;
  agentName: string;
  currentWeaknesses: string[];
  proposedChanges: string[];
  expectedImpact: string;
  validationStatus: 'pending' | 'validating' | 'validated' | 'rejected' | 'deployed';
  simulationRunId?: string;
  simulationPassRate?: number;
  baselinePassRate?: number;
}

export interface DeploymentRecommendation {
  agentId: string;
  agentName: string;
  proposalSummary: string;
  simulationPassRate: number;
  baselinePassRate: number;
  improvement: number;
  recommendation: 'deploy' | 'review' | 'reject';
  reason: string;
}

const logger = createLogger('WORKFORCE_OPTIMIZATION');

function mapInsightRow(row: Record<string, unknown>): WorkforceOptimizationInsight {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    teamId: row.team_id as string,
    category: row.category as string,
    title: row.title as string,
    description: row.description as string,
    impactEstimate: (row.impact_estimate as string) ?? null,
    difficulty: (row.difficulty as string) ?? 'medium',
    estimatedRevenueImpactCents: (row.estimated_revenue_impact_cents as number) ?? null,
    status: row.status as string,
    actionType: (row.action_type as string) ?? null,
    actionPayload: (typeof row.action_payload === 'object' && row.action_payload ? row.action_payload : {}) as Record<string, unknown>,
    sourceData: (typeof row.source_data === 'object' && row.source_data ? row.source_data : {}) as Record<string, unknown>,
    analysisPeriodStart: row.analysis_period_start ? String(row.analysis_period_start) : null,
    analysisPeriodEnd: row.analysis_period_end ? String(row.analysis_period_end) : null,
    acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : null,
    acknowledgedBy: (row.acknowledged_by as string) ?? null,
    dismissedAt: row.dismissed_at ? String(row.dismissed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class WorkforceOptimizationEngine {
  async runAnalysis(tenantId: string, teamId: string): Promise<WorkforceOptimizationInsight[]> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const { rows: members } = await client.query(
        `SELECT wm.agent_id, a.name as agent_name
         FROM workforce_members wm
         JOIN agents a ON a.id = wm.agent_id
         WHERE wm.team_id = $1 AND wm.status = 'active'`,
        [teamId],
      );

      if (members.length === 0) {
        await client.query('COMMIT');
        return [];
      }

      const agentIds = members.map((m) => m.agent_id as string);

      const { rows: callStats } = await client.query(
        `SELECT
           cs.agent_id,
           COUNT(*)::int AS total_calls,
           COUNT(*) FILTER (WHERE cs.lifecycle_state = 'CALL_COMPLETED')::int AS completed,
           COUNT(*) FILTER (WHERE cs.lifecycle_state = 'CALL_FAILED')::int AS failed,
           COUNT(*) FILTER (WHERE cs.lifecycle_state = 'ESCALATED' OR cs.escalation_target IS NOT NULL)::int AS escalated,
           COALESCE(AVG(cs.duration_seconds) FILTER (WHERE cs.duration_seconds > 0), 0)::float AS avg_duration,
           COUNT(*) FILTER (WHERE cs.direction = 'inbound' AND cs.lifecycle_state = 'CALL_COMPLETED'
             AND cs.context->>'callOutcome' IS NOT NULL
             AND (cs.context->'callOutcome'->>'disposition') = 'resolved')::int AS bookings
         FROM call_sessions cs
         WHERE cs.agent_id = ANY($1)
           AND cs.tenant_id = $2
           AND cs.created_at >= $3
           AND cs.created_at < $4
         GROUP BY cs.agent_id`,
        [agentIds, tenantId, sevenDaysAgo, now],
      );

      const { rows: hourlyData } = await client.query(
        `SELECT
           EXTRACT(HOUR FROM cs.created_at)::int AS hour,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE cs.lifecycle_state IN ('CALL_FAILED', 'ESCALATED'))::int AS missed_or_escalated
         FROM call_sessions cs
         WHERE cs.agent_id = ANY($1)
           AND cs.tenant_id = $2
           AND cs.created_at >= $3
           AND cs.created_at < $4
         GROUP BY EXTRACT(HOUR FROM cs.created_at)
         ORDER BY hour`,
        [agentIds, tenantId, sevenDaysAgo, now],
      );

      const { rows: handoffStats } = await client.query(
        `SELECT
           COUNT(*)::int AS total_handoffs,
           COUNT(*) FILTER (WHERE outcome = 'success')::int AS successful_handoffs,
           COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed_handoffs
         FROM workforce_routing_history
         WHERE team_id = $1
           AND tenant_id = $2
           AND created_at >= $3
           AND created_at < $4`,
        [teamId, tenantId, sevenDaysAgo, now],
      );

      await client.query('COMMIT');

      const insights: Array<Omit<WorkforceOptimizationInsight, 'id' | 'createdAt' | 'updatedAt'>> = [];

      const totalCalls = callStats.reduce((sum, r) => sum + ((r.total_calls as number) || 0), 0);
      const totalFailed = callStats.reduce((sum, r) => sum + ((r.failed as number) || 0), 0);
      const totalEscalated = callStats.reduce((sum, r) => sum + ((r.escalated as number) || 0), 0);
      const totalBookings = callStats.reduce((sum, r) => sum + ((r.bookings as number) || 0), 0);

      if (totalCalls < 1) {
        logger.info('Not enough data for workforce optimization analysis', { tenantId, teamId });
        return [];
      }

      const afterHoursMissed = hourlyData
        .filter((h) => ((h.hour as number) >= 18 || (h.hour as number) < 8))
        .reduce((sum, h) => sum + ((h.missed_or_escalated as number) || 0), 0);

      if (afterHoursMissed > 3) {
        insights.push({
          tenantId,
          teamId,
          category: 'missed_opportunity',
          title: `${afterHoursMissed} calls missed or escalated after hours`,
          description: `Over the past 7 days, ${afterHoursMissed} calls outside business hours (6 PM - 8 AM) were missed or escalated. Consider enabling after-hours answering or adjusting agent availability.`,
          impactEstimate: `Could recover ~${afterHoursMissed} calls per week`,
          difficulty: 'easy',
          estimatedRevenueImpactCents: afterHoursMissed * 15000,
          status: 'new',
          actionType: 'enable_feature',
          actionPayload: { feature: 'after_hours_answering', afterHoursMissed },
          sourceData: { afterHoursMissed, hourlyData },
          analysisPeriodStart: sevenDaysAgo.toISOString(),
          analysisPeriodEnd: now.toISOString(),
          acknowledgedAt: null,
          acknowledgedBy: null,
          dismissedAt: null,
        });
      }

      if (totalCalls > 0) {
        const escalationRate = totalEscalated / totalCalls;
        if (escalationRate > 0.15) {
          insights.push({
            tenantId,
            teamId,
            category: 'agent_improvement',
            title: `High escalation rate: ${(escalationRate * 100).toFixed(1)}%`,
            description: `${totalEscalated} out of ${totalCalls} calls were escalated in the past week. This is above the 15% threshold. Review agent prompts to handle more scenarios autonomously.`,
            impactEstimate: `Reducing escalation to 10% could handle ${Math.round(totalEscalated - totalCalls * 0.1)} more calls autonomously`,
            difficulty: 'medium',
            estimatedRevenueImpactCents: Math.round((totalEscalated - totalCalls * 0.1) * 5000),
            status: 'new',
            actionType: 'update_prompt',
            actionPayload: { escalationRate, totalEscalated, totalCalls },
            sourceData: { escalationRate, totalEscalated, totalCalls },
            analysisPeriodStart: sevenDaysAgo.toISOString(),
            analysisPeriodEnd: now.toISOString(),
            acknowledgedAt: null,
            acknowledgedBy: null,
            dismissedAt: null,
          });
        }
      }

      if (totalCalls > 10) {
        const bookingRate = totalBookings / totalCalls;
        if (bookingRate < 0.2) {
          insights.push({
            tenantId,
            teamId,
            category: 'performance',
            title: `Low booking conversion rate: ${(bookingRate * 100).toFixed(1)}%`,
            description: `Only ${totalBookings} bookings from ${totalCalls} calls (${(bookingRate * 100).toFixed(1)}%). Industry average is 25-35%. Consider reviewing scheduling workflows and agent prompts.`,
            impactEstimate: `Improving to 25% could generate ${Math.round(totalCalls * 0.25 - totalBookings)} additional bookings per week`,
            difficulty: 'medium',
            estimatedRevenueImpactCents: Math.round((totalCalls * 0.25 - totalBookings) * 15000),
            status: 'new',
            actionType: 'adjust_schedule',
            actionPayload: { bookingRate, totalBookings, totalCalls },
            sourceData: { bookingRate, totalBookings, totalCalls },
            analysisPeriodStart: sevenDaysAgo.toISOString(),
            analysisPeriodEnd: now.toISOString(),
            acknowledgedAt: null,
            acknowledgedBy: null,
            dismissedAt: null,
          });
        }
      }

      if (totalFailed > 5) {
        insights.push({
          tenantId,
          teamId,
          category: 'performance',
          title: `${totalFailed} failed calls in the past week`,
          description: `${totalFailed} calls failed across the team in the past 7 days. Review call logs to identify common failure patterns and fix configuration issues.`,
          impactEstimate: `Fixing failures could recover ${totalFailed} customer interactions`,
          difficulty: 'easy',
          estimatedRevenueImpactCents: totalFailed * 10000,
          status: 'new',
          actionType: 'review_calls',
          actionPayload: { totalFailed },
          sourceData: { totalFailed, callStats },
          analysisPeriodStart: sevenDaysAgo.toISOString(),
          analysisPeriodEnd: now.toISOString(),
          acknowledgedAt: null,
          acknowledgedBy: null,
          dismissedAt: null,
        });
      }

      const hs = handoffStats[0];
      const failedHandoffs = (hs?.failed_handoffs as number) ?? 0;
      const totalHandoffs = (hs?.total_handoffs as number) ?? 0;
      if (failedHandoffs > 2 && totalHandoffs > 0) {
        insights.push({
          tenantId,
          teamId,
          category: 'workflow',
          title: `${failedHandoffs} failed handoffs between agents`,
          description: `${failedHandoffs} out of ${totalHandoffs} agent handoffs failed this week. Check routing rules and agent availability to improve collaboration.`,
          impactEstimate: `Fixing handoff failures improves ${failedHandoffs} customer experiences per week`,
          difficulty: 'medium',
          estimatedRevenueImpactCents: failedHandoffs * 8000,
          status: 'new',
          actionType: 'review_calls',
          actionPayload: { failedHandoffs, totalHandoffs },
          sourceData: { failedHandoffs, totalHandoffs },
          analysisPeriodStart: sevenDaysAgo.toISOString(),
          analysisPeriodEnd: now.toISOString(),
          acknowledgedAt: null,
          acknowledgedBy: null,
          dismissedAt: null,
        });
      }

      const peakHour = hourlyData.reduce(
        (max, h) => ((h.calls as number) > max.calls ? { hour: h.hour as number, calls: h.calls as number } : max),
        { hour: 0, calls: 0 },
      );
      if (peakHour.calls > totalCalls * 0.2 && totalCalls > 10) {
        insights.push({
          tenantId,
          teamId,
          category: 'scheduling',
          title: `Peak call volume at ${peakHour.hour}:00 (${peakHour.calls} calls)`,
          description: `${((peakHour.calls / totalCalls) * 100).toFixed(0)}% of calls come in around ${peakHour.hour}:00. Ensure maximum agent capacity during this window.`,
          impactEstimate: 'Optimize agent scheduling for peak hours',
          difficulty: 'easy',
          estimatedRevenueImpactCents: null,
          status: 'new',
          actionType: 'adjust_schedule',
          actionPayload: { peakHour: peakHour.hour, peakCalls: peakHour.calls, totalCalls },
          sourceData: { hourlyData },
          analysisPeriodStart: sevenDaysAgo.toISOString(),
          analysisPeriodEnd: now.toISOString(),
          acknowledgedAt: null,
          acknowledgedBy: null,
          dismissedAt: null,
        });
      }

      const insertedInsights: WorkforceOptimizationInsight[] = [];
      const insertClient = await pool.connect();
      try {
        await insertClient.query('BEGIN');
        await withTenantContext(insertClient, tenantId, async () => {
          for (const insight of insights) {
            const { rows } = await insertClient.query(
              `INSERT INTO workforce_optimization_insights
               (tenant_id, team_id, category, title, description, impact_estimate, difficulty,
                estimated_revenue_impact_cents, status, action_type, action_payload, source_data,
                analysis_period_start, analysis_period_end)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
               RETURNING *`,
              [
                insight.tenantId, insight.teamId, insight.category, insight.title,
                insight.description, insight.impactEstimate, insight.difficulty,
                insight.estimatedRevenueImpactCents, insight.status, insight.actionType,
                JSON.stringify(insight.actionPayload), JSON.stringify(insight.sourceData),
                insight.analysisPeriodStart, insight.analysisPeriodEnd,
              ],
            );
            if (rows[0]) {
              insertedInsights.push(mapInsightRow(rows[0]));
            }
          }
        });
        await insertClient.query('COMMIT');
      } catch (err) {
        await insertClient.query('ROLLBACK');
        throw err;
      } finally {
        insertClient.release();
      }

      logger.info('Workforce optimization analysis completed', {
        tenantId, teamId, insightsGenerated: insertedInsights.length,
      });

      return insertedInsights;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Workforce optimization analysis failed', { tenantId, teamId, error: String(err) });
      throw err;
    } finally {
      client.release();
    }
  }

  async getInsights(
    tenantId: string,
    teamId: string,
    options: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<{ insights: WorkforceOptimizationInsight[]; total: number }> {
    const pool = getPlatformPool();
    const client = await pool.connect();
    const limit = Math.min(options.limit ?? 50, 100);
    const offset = options.offset ?? 0;

    try {
      return await withTenantContext(client, tenantId, async () => {
        const conditions = ['tenant_id = $1', 'team_id = $2'];
        const params: unknown[] = [tenantId, teamId];
        let paramIdx = 3;

        if (options.status) {
          conditions.push(`status = $${paramIdx}`);
          params.push(options.status);
          paramIdx++;
        }

        const where = conditions.join(' AND ');

        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int AS total FROM workforce_optimization_insights WHERE ${where}`,
          params,
        );

        const { rows } = await client.query(
          `SELECT * FROM workforce_optimization_insights WHERE ${where}
           ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
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

  async acknowledgeInsight(
    tenantId: string,
    insightId: string,
    userId?: string,
  ): Promise<WorkforceOptimizationInsight | null> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `UPDATE workforce_optimization_insights
           SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $3, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2
           RETURNING *`,
          [insightId, tenantId, userId ?? null],
        );
        return rows[0] ? mapInsightRow(rows[0]) : null;
      });
    } finally {
      client.release();
    }
  }

  async dismissInsight(
    tenantId: string,
    insightId: string,
  ): Promise<WorkforceOptimizationInsight | null> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `UPDATE workforce_optimization_insights
           SET status = 'dismissed', dismissed_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2
           RETURNING *`,
          [insightId, tenantId],
        );
        return rows[0] ? mapInsightRow(rows[0]) : null;
      });
    } finally {
      client.release();
    }
  }

  async generatePromptProposals(
    tenantId: string,
    teamId: string,
  ): Promise<PromptImprovementProposal[]> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const { rows: members } = await client.query(
        `SELECT wm.agent_id, a.name as agent_name, a.system_prompt
         FROM workforce_members wm
         JOIN agents a ON a.id = wm.agent_id
         WHERE wm.team_id = $1 AND wm.status = 'active'`,
        [teamId],
      );

      if (members.length === 0) {
        await client.query('COMMIT');
        return [];
      }

      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const proposals: PromptImprovementProposal[] = [];

      for (const member of members) {
        const agentId = member.agent_id as string;
        const agentName = member.agent_name as string;

        const { rows: stats } = await client.query(
          `SELECT
             COUNT(*)::int AS total_calls,
             COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated,
             COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::int AS failed,
             COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED'
               AND context->>'callOutcome' IS NOT NULL
               AND (context->'callOutcome'->>'disposition') = 'resolved')::int AS resolved,
             COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration
           FROM call_sessions
           WHERE agent_id = $1 AND tenant_id = $2
             AND created_at >= $3 AND created_at < $4`,
          [agentId, tenantId, sevenDaysAgo, now],
        );

        const agentStats = stats[0];
        const totalCalls = (agentStats?.total_calls as number) ?? 0;
        if (totalCalls < 5) continue;

        const escalated = (agentStats?.escalated as number) ?? 0;
        const failed = (agentStats?.failed as number) ?? 0;
        const resolved = (agentStats?.resolved as number) ?? 0;
        const avgDuration = (agentStats?.avg_duration as number) ?? 0;

        const weaknesses: string[] = [];
        const proposedChanges: string[] = [];

        const escalationRate = escalated / totalCalls;
        if (escalationRate > 0.15) {
          weaknesses.push(`High escalation rate (${(escalationRate * 100).toFixed(1)}%): Agent escalates too frequently instead of resolving independently`);
          proposedChanges.push('Add explicit handling instructions for common escalation triggers');
          proposedChanges.push('Expand the scenarios the agent can handle autonomously before escalating');
        }

        const failureRate = failed / totalCalls;
        if (failureRate > 0.1) {
          weaknesses.push(`High failure rate (${(failureRate * 100).toFixed(1)}%): Too many calls ending in failure state`);
          proposedChanges.push('Improve error recovery and fallback handling in agent prompt');
          proposedChanges.push('Add retry logic and graceful degradation instructions');
        }

        const resolutionRate = resolved / totalCalls;
        if (resolutionRate < 0.3 && totalCalls > 10) {
          weaknesses.push(`Low resolution rate (${(resolutionRate * 100).toFixed(1)}%): Agent rarely achieves successful resolutions`);
          proposedChanges.push('Strengthen scheduling/booking instructions in agent prompt');
          proposedChanges.push('Add proactive appointment offering behavior');
        }

        if (avgDuration > 300) {
          weaknesses.push(`Long average call duration (${Math.round(avgDuration)}s): Conversations taking too long`);
          proposedChanges.push('Add instructions to be more concise and goal-directed');
          proposedChanges.push('Reduce unnecessary confirmations and repetitive information gathering');
        }

        if (weaknesses.length > 0) {
          proposals.push({
            agentId,
            agentName,
            currentWeaknesses: weaknesses,
            proposedChanges,
            expectedImpact: `Improving ${weaknesses.length} weakness area(s) could improve call resolution by ${Math.round(weaknesses.length * 5)}-${Math.round(weaknesses.length * 15)}%`,
            validationStatus: 'pending',
          });
        }
      }

      await client.query('COMMIT');

      for (const proposal of proposals) {
        const insightClient = await pool.connect();
        try {
          await withTenantContext(insightClient, tenantId, async () => {
            await insightClient.query(
              `INSERT INTO workforce_optimization_insights
               (tenant_id, team_id, category, title, description, impact_estimate, difficulty,
                status, action_type, action_payload, source_data,
                analysis_period_start, analysis_period_end)
               VALUES ($1, $2, 'agent_improvement', $3, $4, $5, 'medium',
                'new', 'update_prompt', $6, $7, $8, $9)`,
              [
                tenantId, teamId,
                `Prompt improvement proposal for ${proposal.agentName}`,
                `Detected ${proposal.currentWeaknesses.length} weakness(es): ${proposal.currentWeaknesses.map((w) => w.split(':')[0]).join(', ')}. Proposed ${proposal.proposedChanges.length} change(s) to improve performance.`,
                proposal.expectedImpact,
                JSON.stringify({ agentId: proposal.agentId, proposedChanges: proposal.proposedChanges }),
                JSON.stringify({ weaknesses: proposal.currentWeaknesses, proposal }),
                sevenDaysAgo.toISOString(), now.toISOString(),
              ],
            );
          });
        } finally {
          insightClient.release();
        }
      }

      logger.info('Prompt improvement proposals generated', {
        tenantId, teamId, proposalCount: proposals.length,
      });

      return proposals;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Failed to generate prompt proposals', { tenantId, teamId, error: String(err) });
      throw err;
    } finally {
      client.release();
    }
  }

  async validateProposalWithSimulation(
    tenantId: string,
    teamId: string,
    agentId: string,
  ): Promise<{ simulationRunId: string; passRate: number; baselinePassRate: number } | null> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT id FROM agents WHERE id = $1 AND tenant_id = $2`,
          [agentId, tenantId],
        );
        if (rows.length === 0) throw new Error('Agent not found');
      });

      const scenarios = await listScenarios(tenantId);
      if (scenarios.length === 0) {
        logger.info('No simulation scenarios available for validation', { tenantId, agentId });
        return null;
      }

      const scenarioIds = scenarios.slice(0, 5).map((s) => s.id);

      const run = await createSimulationRun(
        tenantId, agentId, scenarioIds,
        `[AIWOS] Prompt validation for ${agentId}`,
        'post-optimization',
      );

      try {
        await executeSimulationRun(tenantId, run.id);
      } catch (execErr) {
        logger.warn('Simulation execution failed, reporting results as available', {
          tenantId, agentId, runId: run.id, error: String(execErr),
        });
      }

      const results = await getSimulationResults(tenantId, run.id);
      const completed = results.filter((r) => r.status === 'completed');
      const passed = completed.filter((r) => r.scores?.passed === true);
      const passRate = completed.length > 0 ? passed.length / completed.length : 0;

      const { rows: prevRuns } = await client.query(
        `SELECT id FROM simulation_runs
         WHERE agent_id = $1 AND tenant_id = $2 AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
        [agentId, tenantId],
      );

      let baselinePassRate = 0;
      if (prevRuns.length > 0) {
        const baseResults = await getSimulationResults(tenantId, prevRuns[0].id as string);
        const baseCompleted = baseResults.filter((r) => r.status === 'completed');
        const basePassed = baseCompleted.filter((r) => r.scores?.passed === true);
        baselinePassRate = baseCompleted.length > 0 ? basePassed.length / baseCompleted.length : 0;
      }

      await withTenantContext(client, tenantId, async () => {
        await client.query(
          `INSERT INTO workforce_optimization_insights
           (tenant_id, team_id, category, title, description, impact_estimate, difficulty,
            status, action_type, action_payload, source_data,
            analysis_period_start, analysis_period_end)
           VALUES ($1, $2, 'agent_improvement',
            'Simulation validation completed',
            $3, $4, 'medium', 'new', 'deploy_prompt',
            $5, $6, NOW() - INTERVAL '7 days', NOW())`,
          [
            tenantId, teamId,
            `Simulation run completed for agent with pass rate ${(passRate * 100).toFixed(0)}% (baseline: ${(baselinePassRate * 100).toFixed(0)}%).`,
            passRate > baselinePassRate
              ? `Improvement of ${((passRate - baselinePassRate) * 100).toFixed(0)}% in pass rate`
              : 'No improvement detected',
            JSON.stringify({ agentId, simulationRunId: run.id, passRate, baselinePassRate }),
            JSON.stringify({ passRate, baselinePassRate, completedScenarios: completed.length }),
          ],
        );
      });

      logger.info('Prompt proposal validated via simulation', {
        tenantId, teamId, agentId, runId: run.id, passRate, baselinePassRate,
      });

      return { simulationRunId: run.id, passRate, baselinePassRate };
    } finally {
      client.release();
    }
  }

  async generateDeploymentRecommendations(
    tenantId: string,
    teamId: string,
  ): Promise<DeploymentRecommendation[]> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      const recommendations: DeploymentRecommendation[] = [];

      const insights = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT * FROM workforce_optimization_insights
           WHERE tenant_id = $1 AND team_id = $2
             AND action_type = 'deploy_prompt'
             AND status = 'new'
           ORDER BY created_at DESC`,
          [tenantId, teamId],
        );
        return rows;
      });

      for (const insight of insights) {
        const payload = insight.action_payload as Record<string, unknown>;
        const agentId = payload.agentId as string;
        const passRate = (payload.passRate as number) ?? 0;
        const baselinePassRate = (payload.baselinePassRate as number) ?? 0;
        const improvement = passRate - baselinePassRate;

        const { rows: agentRows } = await client.query(
          `SELECT name FROM agents WHERE id = $1 AND tenant_id = $2`,
          [agentId, tenantId],
        );
        const agentName = (agentRows[0]?.name as string) ?? 'Unknown';

        let recommendation: 'deploy' | 'review' | 'reject';
        let reason: string;

        if (passRate >= 0.8 && improvement >= 0.05) {
          recommendation = 'deploy';
          reason = `Pass rate ${(passRate * 100).toFixed(0)}% exceeds threshold (80%) with ${(improvement * 100).toFixed(0)}% improvement over baseline. Safe to deploy.`;
        } else if (passRate >= 0.6 && improvement >= 0) {
          recommendation = 'review';
          reason = `Pass rate ${(passRate * 100).toFixed(0)}% is acceptable but improvement is marginal (${(improvement * 100).toFixed(0)}%). Manual review recommended before deployment.`;
        } else {
          recommendation = 'reject';
          reason = passRate < 0.6
            ? `Pass rate ${(passRate * 100).toFixed(0)}% is below minimum threshold (60%). Do not deploy.`
            : `Performance regressed by ${(Math.abs(improvement) * 100).toFixed(0)}%. Revert proposed changes.`;
        }

        recommendations.push({
          agentId,
          agentName,
          proposalSummary: insight.description as string,
          simulationPassRate: passRate,
          baselinePassRate,
          improvement,
          recommendation,
          reason,
        });
      }

      logger.info('Deployment recommendations generated', {
        tenantId, teamId, count: recommendations.length,
        deployCount: recommendations.filter((r) => r.recommendation === 'deploy').length,
      });

      return recommendations;
    } finally {
      client.release();
    }
  }
}
