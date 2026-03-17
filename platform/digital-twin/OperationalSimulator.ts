import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import {
  createSimulationRun as createSimEngineRun,
  executeSimulationRun as execSimEngineRun,
  compareSimulationRuns as compareSimEngineRuns,
  listScenarios as listSimEngineScenarios,
} from '../simulation/SimulationEngine';
import type { OperationalSnapshot } from './DigitalTwinModelService';

const logger = createLogger('OPERATIONAL_SIMULATOR');

export interface DigitalTwinScenario {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  category: string;
  scenarioType: string;
  parameters: ScenarioParameters;
  isPredefined: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioParameters {
  callVolumeChangePercent?: number;
  promptVersion?: string;
  baselinePromptVersion?: string;
  dispatchHoursExtension?: number;
  staffingChangePercent?: number;
  campaignContactCount?: number;
  campaignConversionRate?: number;
  workflowChanges?: Record<string, unknown>;
  customFactors?: Record<string, number>;
  agentId?: string;
  simulationScenarioIds?: string[];
}

export interface SimulationRun {
  id: string;
  tenantId: string;
  modelId: string;
  scenarioId: string;
  name: string | null;
  status: string;
  parameters: ScenarioParameters;
  isSimulation: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface SimulationResult {
  id: string;
  tenantId: string;
  runId: string;
  resultType: string;
  metrics: SimulationMetrics;
  comparisonBaseline: SimulationMetrics;
  summary: string | null;
  isSimulation: boolean;
  recommendationId: string | null;
  conversationQuality: ConversationQualityResults | null;
  createdAt: string;
}

export interface ConversationQualityResults {
  baselineRunId?: string;
  variantRunId?: string;
  baseline?: ConversationQualityScores;
  variant?: ConversationQualityScores;
  comparison?: {
    overallImprovement: number;
    passRateImprovement: number;
    helpfulnessImprovement: number;
    toneImprovement: number;
    resolutionImprovement: number;
  };
  frictionPoints?: string[];
}

export interface ConversationQualityScores {
  avgOverall: number;
  avgHelpfulness: number;
  avgTone: number;
  avgResolution: number;
  passRate: number;
  totalScenarios: number;
  completedScenarios: number;
  failedScenarios: number;
}

export interface SimulationMetrics {
  projectedDailyCallVolume: number;
  projectedBookingRate: number;
  projectedRevenuePerDayCents: number;
  projectedEscalationRate: number;
  projectedAvgCallDuration: number;
  projectedStaffingNeeded: number;
  projectedMonthlyRevenueCents: number;
  conversionRateDelta: number;
  revenueDeltaCents: number;
  callVolumeDelta: number;
  riskLevel: string;
  insights: string[];
}

export async function createScenario(
  tenantId: string,
  data: {
    name: string;
    description?: string;
    category?: string;
    scenarioType?: string;
    parameters: ScenarioParameters;
  },
): Promise<DigitalTwinScenario> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const row = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO digital_twin_scenarios (tenant_id, name, description, category, scenario_type, parameters)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenantId, data.name, data.description ?? null, data.category ?? 'custom',
         data.scenarioType ?? 'operational', JSON.stringify(data.parameters)],
      );
      return rows[0];
    });
    return mapScenarioRow(row);
  } finally {
    client.release();
  }
}

export async function listScenarios(tenantId: string, category?: string): Promise<DigitalTwinScenario[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const params: unknown[] = [tenantId];
      let where = `WHERE (tenant_id = $1 OR tenant_id = '__system__')`;
      if (category) {
        params.push(category);
        where += ` AND category = $${params.length}`;
      }
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_scenarios ${where} ORDER BY is_predefined DESC, name ASC`,
        params,
      );
      return rows;
    });
    return rows.map(mapScenarioRow);
  } finally {
    client.release();
  }
}

export async function getScenario(tenantId: string, scenarioId: string): Promise<DigitalTwinScenario | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_scenarios WHERE id = $1 AND (tenant_id = $2 OR tenant_id = '__system__')`,
        [scenarioId, tenantId],
      );
      return rows;
    });
    return rows.length > 0 ? mapScenarioRow(rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function runSimulation(
  tenantId: string,
  modelId: string,
  scenarioId: string,
  name?: string,
  parameterOverrides?: Partial<ScenarioParameters>,
): Promise<{ run: SimulationRun; result: SimulationResult }> {
  const pool = getPlatformPool();

  const { snapshot, mergedParams, scenarioType, runRow } = await initSimulationRun(
    pool, tenantId, modelId, scenarioId, name, parameterOverrides,
  );

  const baseline = computeBaselineMetrics(snapshot);
  const simulated = computeSimulatedMetrics(snapshot, mergedParams);

  let conversationQuality: ConversationQualityResults | null = null;
  if (scenarioType === 'prompt_ab' || scenarioType === 'workflow') {
    conversationQuality = await runConversationComparison(tenantId, mergedParams, scenarioType);
  }

  return finalizeSimulationRun(pool, tenantId, runRow, scenarioType, baseline, simulated, mergedParams, conversationQuality);
}

async function initSimulationRun(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  modelId: string,
  scenarioId: string,
  name: string | undefined,
  parameterOverrides: Partial<ScenarioParameters> | undefined,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const modelRows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_models WHERE id = $1 AND tenant_id = $2`,
        [modelId, tenantId],
      );
      return rows;
    });
    if (modelRows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Digital twin model not found');
    }

    const model = modelRows[0];
    const snapshot: OperationalSnapshot = typeof model.snapshot_data === 'string'
      ? JSON.parse(model.snapshot_data) : model.snapshot_data;

    const scenarioRows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_scenarios WHERE id = $1 AND (tenant_id = $2 OR tenant_id = '__system__')`,
        [scenarioId, tenantId],
      );
      return rows;
    });
    if (scenarioRows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Scenario not found');
    }

    const scenario = scenarioRows[0];
    const baseParams: ScenarioParameters = typeof scenario.parameters === 'string'
      ? JSON.parse(scenario.parameters) : scenario.parameters;
    const mergedParams = { ...baseParams, ...parameterOverrides };
    const scenarioType = scenario.scenario_type as string;

    const runRow = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO digital_twin_simulation_runs (tenant_id, model_id, scenario_id, name, status, parameters, is_simulation)
         VALUES ($1, $2, $3, $4, 'running', $5, true) RETURNING *`,
        [tenantId, modelId, scenarioId, name ?? null, JSON.stringify(mergedParams)],
      );
      return rows[0];
    });

    await client.query('COMMIT');
    return { snapshot, mergedParams, scenarioType, runRow };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function finalizeSimulationRun(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  runRow: Record<string, unknown>,
  scenarioType: string,
  baseline: SimulationMetrics,
  simulated: SimulationMetrics,
  mergedParams: ScenarioParameters,
  conversationQuality: ConversationQualityResults | null,
): Promise<{ run: SimulationRun; result: SimulationResult }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const resultType = scenarioType === 'prompt_ab' ? 'prompt_comparison'
      : scenarioType === 'workflow' ? 'workflow_comparison' : 'operational';

    const resultRow = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO digital_twin_results (tenant_id, run_id, result_type, metrics, comparison_baseline, summary, conversation_quality, is_simulation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
        [tenantId, runRow.id, resultType,
         JSON.stringify(simulated), JSON.stringify(baseline),
         generateSummary(baseline, simulated, mergedParams, conversationQuality),
         conversationQuality ? JSON.stringify(conversationQuality) : null],
      );
      return rows[0];
    });

    await withTenantContext(client, tenantId, async () => {
      await client.query(
        `UPDATE digital_twin_simulation_runs SET status = 'completed', completed_at = NOW(), started_at = NOW() WHERE id = $1`,
        [runRow.id],
      );
    });

    await client.query('COMMIT');

    logger.info('Simulation completed', { tenantId, runId: runRow.id as string, scenarioType });
    return {
      run: mapRunRow({ ...runRow, status: 'completed', started_at: new Date(), completed_at: new Date() }),
      result: mapResultRow(resultRow),
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }

    const failClient = await pool.connect();
    try {
      await withTenantContext(failClient, tenantId, async () => {
        await failClient.query(
          `UPDATE digital_twin_simulation_runs SET status = 'failed', completed_at = NOW() WHERE id = $1 AND tenant_id = $2`,
          [runRow.id, tenantId],
        );
      });
    } finally {
      failClient.release();
    }

    throw err;
  } finally {
    client.release();
  }
}

async function runConversationComparison(
  tenantId: string,
  params: ScenarioParameters,
  scenarioType: string,
): Promise<ConversationQualityResults> {
  const agentId = params.agentId;
  if (!agentId) {
    return {
      frictionPoints: ['No agentId specified in scenario parameters — conversation testing requires a target agent.'],
    };
  }

  let simScenarioIds = params.simulationScenarioIds;
  if (!simScenarioIds || simScenarioIds.length === 0) {
    const existingScenarios = await listSimEngineScenarios(tenantId);
    if (existingScenarios.length === 0) {
      return {
        frictionPoints: ['No simulation scenarios available for conversation testing. Create scenarios in Simulation Lab first.'],
      };
    }
    simScenarioIds = existingScenarios.slice(0, 5).map(s => s.id);
  }

  try {
    const baselineLabel = scenarioType === 'prompt_ab'
      ? (params.baselinePromptVersion || 'baseline')
      : 'baseline-workflow';
    const variantLabel = scenarioType === 'prompt_ab'
      ? (params.promptVersion || 'variant')
      : 'variant-workflow';

    const baselineRun = await createSimEngineRun(
      tenantId, agentId, simScenarioIds,
      `Digital Twin ${scenarioType} baseline`, baselineLabel,
    );

    await execSimEngineRun(tenantId, baselineRun.id);

    let variantAgentId = agentId;
    let ephemeralAgentId: string | null = null;

    if (scenarioType === 'prompt_ab' && params.promptVersion) {
      ephemeralAgentId = await createEphemeralAgentClone(tenantId, agentId, params.promptVersion);
      variantAgentId = ephemeralAgentId;
    } else if (scenarioType === 'workflow' && params.workflowChanges) {
      const overlay = Object.entries(params.workflowChanges)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join('\n');
      ephemeralAgentId = await createEphemeralAgentClone(tenantId, agentId, undefined, overlay);
      variantAgentId = ephemeralAgentId;
    }

    const variantRun = await createSimEngineRun(
      tenantId, variantAgentId, simScenarioIds,
      `Digital Twin ${scenarioType} variant`, variantLabel,
    );

    try {
      await execSimEngineRun(tenantId, variantRun.id);
    } finally {
      if (ephemeralAgentId) {
        await deleteEphemeralAgent(tenantId, ephemeralAgentId);
      }
    }

    const comparison = await compareSimEngineRuns(tenantId, [baselineRun.id, variantRun.id]);

    const baselineComp = comparison.comparison.find(c => c.runId === baselineRun.id);
    const variantComp = comparison.comparison.find(c => c.runId === variantRun.id);

    if (!baselineComp || !variantComp) {
      return {
        baselineRunId: baselineRun.id,
        variantRunId: variantRun.id,
        frictionPoints: ['Could not retrieve comparison data for one or both runs.'],
      };
    }

    const frictionPoints: string[] = [];
    if (variantComp.avgOverall < baselineComp.avgOverall) {
      frictionPoints.push(`Overall quality decreased from ${baselineComp.avgOverall.toFixed(1)} to ${variantComp.avgOverall.toFixed(1)}`);
    }
    if (variantComp.passRate < baselineComp.passRate) {
      frictionPoints.push(`Pass rate dropped from ${baselineComp.passRate.toFixed(1)}% to ${variantComp.passRate.toFixed(1)}%`);
    }
    if (variantComp.avgResolution < baselineComp.avgResolution) {
      frictionPoints.push(`Resolution quality decreased from ${baselineComp.avgResolution.toFixed(1)} to ${variantComp.avgResolution.toFixed(1)}`);
    }
    if (variantComp.failedScenarios > baselineComp.failedScenarios) {
      frictionPoints.push(`Failed scenarios increased from ${baselineComp.failedScenarios} to ${variantComp.failedScenarios}`);
    }

    return {
      baselineRunId: baselineRun.id,
      variantRunId: variantRun.id,
      baseline: {
        avgOverall: baselineComp.avgOverall,
        avgHelpfulness: baselineComp.avgHelpfulness,
        avgTone: baselineComp.avgTone,
        avgResolution: baselineComp.avgResolution,
        passRate: baselineComp.passRate,
        totalScenarios: baselineComp.totalScenarios,
        completedScenarios: baselineComp.completedScenarios,
        failedScenarios: baselineComp.failedScenarios,
      },
      variant: {
        avgOverall: variantComp.avgOverall,
        avgHelpfulness: variantComp.avgHelpfulness,
        avgTone: variantComp.avgTone,
        avgResolution: variantComp.avgResolution,
        passRate: variantComp.passRate,
        totalScenarios: variantComp.totalScenarios,
        completedScenarios: variantComp.completedScenarios,
        failedScenarios: variantComp.failedScenarios,
      },
      comparison: {
        overallImprovement: variantComp.avgOverall - baselineComp.avgOverall,
        passRateImprovement: variantComp.passRate - baselineComp.passRate,
        helpfulnessImprovement: variantComp.avgHelpfulness - baselineComp.avgHelpfulness,
        toneImprovement: variantComp.avgTone - baselineComp.avgTone,
        resolutionImprovement: variantComp.avgResolution - baselineComp.avgResolution,
      },
      frictionPoints: frictionPoints.length > 0 ? frictionPoints : undefined,
    };
  } catch (err) {
    logger.error('Conversation comparison failed', { tenantId, error: String(err) });
    return {
      frictionPoints: [`Conversation comparison failed: ${String(err)}`],
    };
  }
}

async function createEphemeralAgentClone(
  tenantId: string,
  sourceAgentId: string,
  promptOverride?: string,
  promptSuffix?: string,
): Promise<string> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const cloneId = await withTenantContext(client, tenantId, async () => {
      const { rows: sourceRows } = await client.query(
        `SELECT name, type, system_prompt, voice, model, temperature, tools, knowledge_base, escalation_config, welcome_greeting
         FROM agents WHERE id = $1 AND tenant_id = $2`,
        [sourceAgentId, tenantId],
      );
      if (sourceRows.length === 0) throw new Error('Source agent not found');

      const src = sourceRows[0] as Record<string, unknown>;
      let prompt = src.system_prompt as string ?? '';
      if (promptOverride) {
        prompt = promptOverride;
      } else if (promptSuffix) {
        prompt = `${prompt}\n\n[WORKFLOW MODIFICATIONS FOR A/B TEST]\n${promptSuffix}`;
      }

      const { rows: cloneRows } = await client.query(
        `INSERT INTO agents (tenant_id, name, type, system_prompt, voice, model, temperature, tools, knowledge_base, escalation_config, welcome_greeting, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'simulation', $12)
         RETURNING id`,
        [tenantId, `[SIM] ${src.name}`, src.type, prompt, src.voice, src.model, src.temperature,
         JSON.stringify(src.tools ?? []), JSON.stringify(src.knowledge_base ?? {}),
         JSON.stringify(src.escalation_config ?? {}), src.welcome_greeting,
         JSON.stringify({ ephemeral: true, sourceAgentId: sourceAgentId })],
      );
      return cloneRows[0].id as string;
    });

    return cloneId;
  } finally {
    client.release();
  }
}

async function deleteEphemeralAgent(
  tenantId: string,
  agentId: string,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {
      await client.query(
        `DELETE FROM agents WHERE id = $1 AND tenant_id = $2 AND status = 'simulation'`,
        [agentId, tenantId],
      );
    });
  } finally {
    client.release();
  }
}

export async function getSimulationRun(tenantId: string, runId: string): Promise<SimulationRun | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_simulation_runs WHERE id = $1 AND tenant_id = $2`,
        [runId, tenantId],
      );
      return rows;
    });
    return rows.length > 0 ? mapRunRow(rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function listSimulationRuns(
  tenantId: string,
  modelId?: string,
  limit = 20,
  offset = 0,
): Promise<{ runs: SimulationRun[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const result = await withTenantContext(client, tenantId, async () => {
      const params: unknown[] = [tenantId];
      let where = 'WHERE tenant_id = $1';
      if (modelId) {
        params.push(modelId);
        where += ` AND model_id = $${params.length}`;
      }
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM digital_twin_simulation_runs ${where}`, params,
      );
      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_simulation_runs ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total: parseInt(countRows[0].total as string) };
    });
    return { runs: result.rows.map(mapRunRow), total: result.total };
  } finally {
    client.release();
  }
}

export async function getSimulationResults(tenantId: string, runId: string): Promise<SimulationResult[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM digital_twin_results WHERE run_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
        [runId, tenantId],
      );
      return rows;
    });
    return rows.map(mapResultRow);
  } finally {
    client.release();
  }
}

export async function compareScenarios(
  tenantId: string,
  runIds: string[],
): Promise<{ runs: SimulationRun[]; results: SimulationResult[][] }> {
  const runs: SimulationRun[] = [];
  const results: SimulationResult[][] = [];
  for (const runId of runIds) {
    const run = await getSimulationRun(tenantId, runId);
    if (run) {
      runs.push(run);
      const res = await getSimulationResults(tenantId, runId);
      results.push(res);
    }
  }
  return { runs, results };
}

export async function seedPredefinedScenarios(): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM digital_twin_scenarios WHERE tenant_id = '__system__' AND is_predefined = true`,
    );
    if (parseInt(existing[0].cnt as string) > 0) return;

    const scenarios = getPredefinedScenarios();
    for (const s of scenarios) {
      await client.query(
        `INSERT INTO digital_twin_scenarios (tenant_id, name, description, category, scenario_type, parameters, is_predefined)
         VALUES ('__system__', $1, $2, $3, $4, $5, true)`,
        [s.name, s.description, s.category, s.scenarioType, JSON.stringify(s.parameters)],
      );
    }
    logger.info('Seeded predefined digital twin scenarios', { count: scenarios.length });
  } finally {
    client.release();
  }
}

function getPredefinedScenarios() {
  return [
    {
      name: 'Seasonal Demand Spike (20% Increase)',
      description: 'Simulates a 20% increase in call volume typical of peak seasonal demand',
      category: 'seasonal',
      scenarioType: 'call_volume',
      parameters: { callVolumeChangePercent: 20 },
    },
    {
      name: 'Seasonal Demand Spike (50% Increase)',
      description: 'Simulates a 50% increase in call volume for extreme seasonal peaks',
      category: 'seasonal',
      scenarioType: 'call_volume',
      parameters: { callVolumeChangePercent: 50 },
    },
    {
      name: 'Emergency Service Demand Surge',
      description: 'Simulates an emergency event causing a sudden 100% call volume increase with lower conversion rates',
      category: 'emergency',
      scenarioType: 'call_volume',
      parameters: { callVolumeChangePercent: 100, customFactors: { conversionRateModifier: -0.15 } },
    },
    {
      name: 'Marketing Campaign Launch',
      description: 'Simulates launching an outbound campaign with 500 contacts at 8% conversion',
      category: 'campaign',
      scenarioType: 'campaign',
      parameters: { campaignContactCount: 500, campaignConversionRate: 0.08, callVolumeChangePercent: 15 },
    },
    {
      name: 'Large Marketing Campaign',
      description: 'Simulates a large outbound campaign with 2000 contacts at 5% conversion',
      category: 'campaign',
      scenarioType: 'campaign',
      parameters: { campaignContactCount: 2000, campaignConversionRate: 0.05, callVolumeChangePercent: 30 },
    },
    {
      name: 'Staffing Shortage (-25%)',
      description: 'Simulates a 25% reduction in available staffing/agent capacity',
      category: 'staffing',
      scenarioType: 'staffing',
      parameters: { staffingChangePercent: -25 },
    },
    {
      name: 'Staffing Expansion (+50%)',
      description: 'Simulates adding 50% more staffing/agent capacity',
      category: 'staffing',
      scenarioType: 'staffing',
      parameters: { staffingChangePercent: 50 },
    },
    {
      name: 'Extended Dispatch Hours (+4hrs)',
      description: 'Simulates extending dispatch/operating hours by 4 hours',
      category: 'operations',
      scenarioType: 'dispatch',
      parameters: { dispatchHoursExtension: 4 },
    },
    {
      name: 'Off-Season Slowdown (-30%)',
      description: 'Simulates a 30% decrease in call volume during off-season',
      category: 'seasonal',
      scenarioType: 'call_volume',
      parameters: { callVolumeChangePercent: -30 },
    },
    {
      name: 'Prompt A/B Test',
      description: 'Runs baseline vs variant prompt through actual agent conversation simulations to compare quality scores and identify friction points',
      category: 'prompt_testing',
      scenarioType: 'prompt_ab',
      parameters: { customFactors: { conversionRateModifier: 0.10 } },
    },
    {
      name: 'Workflow Change Test',
      description: 'Runs baseline vs modified workflow through actual agent conversation simulations to compare conversion and quality impact',
      category: 'workflow_testing',
      scenarioType: 'workflow',
      parameters: { workflowChanges: { description: 'Modify workflow logic and compare with baseline' } },
    },
  ];
}

function computeBaselineMetrics(snapshot: OperationalSnapshot): SimulationMetrics {
  const dailyVolume = snapshot.avgDailyCallVolume || 0;
  const bookingRate = snapshot.bookingConversionRate || 0;
  const dailyBookings = dailyVolume * bookingRate;
  const dailyRevenue = dailyBookings * (snapshot.avgRevenuePerBookingCents || 15000);
  const agentCount = snapshot.agentPerformance?.length || 1;
  const callsPerAgent = agentCount > 0 ? dailyVolume / agentCount : dailyVolume;
  const staffingNeeded = callsPerAgent > 0 ? Math.ceil(dailyVolume / Math.max(callsPerAgent, 1)) : 1;

  return {
    projectedDailyCallVolume: dailyVolume,
    projectedBookingRate: bookingRate,
    projectedRevenuePerDayCents: Math.round(dailyRevenue),
    projectedEscalationRate: snapshot.escalationRate || 0,
    projectedAvgCallDuration: snapshot.avgCallDurationSeconds || 0,
    projectedStaffingNeeded: staffingNeeded,
    projectedMonthlyRevenueCents: Math.round(dailyRevenue * 30),
    conversionRateDelta: 0,
    revenueDeltaCents: 0,
    callVolumeDelta: 0,
    riskLevel: 'low',
    insights: [],
  };
}

function computeSimulatedMetrics(
  snapshot: OperationalSnapshot,
  params: ScenarioParameters,
): SimulationMetrics {
  const baseline = computeBaselineMetrics(snapshot);
  let dailyVolume = baseline.projectedDailyCallVolume;
  let bookingRate = baseline.projectedBookingRate;
  let escalationRate = baseline.projectedEscalationRate;
  let avgDuration = baseline.projectedAvgCallDuration;
  let staffingNeeded = baseline.projectedStaffingNeeded;
  const insights: string[] = [];

  if (params.callVolumeChangePercent !== undefined) {
    const factor = 1 + params.callVolumeChangePercent / 100;
    dailyVolume = Math.round(dailyVolume * factor);
    insights.push(`Call volume ${params.callVolumeChangePercent > 0 ? 'increased' : 'decreased'} by ${Math.abs(params.callVolumeChangePercent)}%`);

    if (params.callVolumeChangePercent > 30) {
      escalationRate = Math.min(1, escalationRate * 1.2);
      bookingRate = Math.max(0, bookingRate * 0.95);
      insights.push('High call volume may slightly increase escalation rate and reduce conversion');
    }
  }

  if (params.staffingChangePercent !== undefined) {
    const factor = 1 + params.staffingChangePercent / 100;
    staffingNeeded = Math.max(1, Math.round(staffingNeeded * factor));

    if (params.staffingChangePercent < 0) {
      escalationRate = Math.min(1, escalationRate * (1 + Math.abs(params.staffingChangePercent) / 200));
      avgDuration = avgDuration * 1.1;
      insights.push('Reduced staffing may increase escalation rates and call durations');
    } else {
      escalationRate = Math.max(0, escalationRate * 0.9);
      insights.push('Increased staffing should reduce escalation rates');
    }
  }

  if (params.dispatchHoursExtension !== undefined && params.dispatchHoursExtension > 0) {
    const additionalPercent = (params.dispatchHoursExtension / 24) * 0.5;
    dailyVolume = Math.round(dailyVolume * (1 + additionalPercent));
    bookingRate = Math.min(1, bookingRate * 1.05);
    insights.push(`Extended hours by ${params.dispatchHoursExtension}h may capture ${Math.round(additionalPercent * 100)}% more calls`);
  }

  if (params.campaignContactCount !== undefined && params.campaignContactCount > 0) {
    const campaignCalls = Math.round(params.campaignContactCount * (params.campaignConversionRate ?? 0.05));
    dailyVolume += Math.round(campaignCalls / 30);
    insights.push(`Campaign adds ~${Math.round(campaignCalls / 30)} daily outbound calls`);
  }

  if (params.workflowChanges && Object.keys(params.workflowChanges).length > 0) {
    const wfDescription = params.workflowChanges.description ?? 'workflow modification';
    insights.push(`Workflow change applied: ${wfDescription}. Conversation-level comparison executed via SimulationEngine.`);
  }

  const conversionModifier = params.customFactors?.conversionRateModifier ?? 0;
  if (conversionModifier !== 0) {
    bookingRate = Math.max(0, Math.min(1, bookingRate + conversionModifier));
    insights.push(`Conversion rate ${conversionModifier > 0 ? 'improved' : 'decreased'} by ${Math.abs(conversionModifier * 100).toFixed(1)}%`);
  }

  const dailyBookings = dailyVolume * bookingRate;
  const dailyRevenue = dailyBookings * (snapshot.avgRevenuePerBookingCents || 15000);
  const callVolumeDelta = dailyVolume - baseline.projectedDailyCallVolume;
  const conversionDelta = bookingRate - baseline.projectedBookingRate;
  const revenueDelta = Math.round(dailyRevenue) - baseline.projectedRevenuePerDayCents;

  let riskLevel = 'low';
  if (Math.abs(callVolumeDelta) > baseline.projectedDailyCallVolume * 0.5) riskLevel = 'high';
  else if (Math.abs(callVolumeDelta) > baseline.projectedDailyCallVolume * 0.2) riskLevel = 'medium';
  if (escalationRate > 0.3) riskLevel = 'high';

  return {
    projectedDailyCallVolume: dailyVolume,
    projectedBookingRate: bookingRate,
    projectedRevenuePerDayCents: Math.round(dailyRevenue),
    projectedEscalationRate: escalationRate,
    projectedAvgCallDuration: avgDuration,
    projectedStaffingNeeded: staffingNeeded,
    projectedMonthlyRevenueCents: Math.round(dailyRevenue * 30),
    conversionRateDelta: conversionDelta,
    revenueDeltaCents: revenueDelta,
    callVolumeDelta,
    riskLevel,
    insights,
  };
}

function generateSummary(
  baseline: SimulationMetrics,
  simulated: SimulationMetrics,
  params: ScenarioParameters,
  conversationQuality: ConversationQualityResults | null,
): string {
  const parts: string[] = [];
  if (simulated.callVolumeDelta !== 0) {
    const dir = simulated.callVolumeDelta > 0 ? 'increase' : 'decrease';
    parts.push(`Projected daily call volume ${dir} of ${Math.abs(simulated.callVolumeDelta)} calls`);
  }
  if (simulated.conversionRateDelta !== 0) {
    const dir = simulated.conversionRateDelta > 0 ? 'improvement' : 'decline';
    parts.push(`Conversion rate ${dir} of ${(Math.abs(simulated.conversionRateDelta) * 100).toFixed(1)}%`);
  }
  if (simulated.revenueDeltaCents !== 0) {
    const dir = simulated.revenueDeltaCents > 0 ? 'increase' : 'decrease';
    parts.push(`Daily revenue ${dir} of $${(Math.abs(simulated.revenueDeltaCents) / 100).toFixed(0)}`);
  }
  if (conversationQuality?.comparison) {
    const cq = conversationQuality.comparison;
    if (cq.overallImprovement !== 0) {
      const dir = cq.overallImprovement > 0 ? 'improved' : 'declined';
      parts.push(`Conversation quality ${dir} by ${Math.abs(cq.overallImprovement).toFixed(1)} points`);
    }
    if (cq.passRateImprovement !== 0) {
      const dir = cq.passRateImprovement > 0 ? 'improved' : 'declined';
      parts.push(`Pass rate ${dir} by ${Math.abs(cq.passRateImprovement).toFixed(1)}%`);
    }
  }
  if (conversationQuality?.frictionPoints && conversationQuality.frictionPoints.length > 0) {
    parts.push(`Friction points: ${conversationQuality.frictionPoints.join('; ')}`);
  }
  parts.push(`Risk level: ${simulated.riskLevel}`);
  return parts.join('. ') + '.';
}

function mapScenarioRow(row: Record<string, unknown>): DigitalTwinScenario {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    category: row.category as string,
    scenarioType: row.scenario_type as string,
    parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters as string) : (row.parameters as ScenarioParameters),
    isPredefined: row.is_predefined as boolean,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRunRow(row: Record<string, unknown>): SimulationRun {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    modelId: row.model_id as string,
    scenarioId: row.scenario_id as string,
    name: (row.name as string | null) ?? null,
    status: row.status as string,
    parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters as string) : (row.parameters as ScenarioParameters),
    isSimulation: row.is_simulation as boolean,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    createdAt: String(row.created_at),
  };
}

function mapResultRow(row: Record<string, unknown>): SimulationResult {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    runId: row.run_id as string,
    resultType: row.result_type as string,
    metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics as string) : (row.metrics as SimulationMetrics),
    comparisonBaseline: typeof row.comparison_baseline === 'string'
      ? JSON.parse(row.comparison_baseline as string)
      : ((row.comparison_baseline ?? {}) as SimulationMetrics),
    summary: (row.summary as string | null) ?? null,
    isSimulation: row.is_simulation as boolean,
    recommendationId: (row.recommendation_id as string | null) ?? null,
    conversationQuality: row.conversation_quality
      ? (typeof row.conversation_quality === 'string'
        ? JSON.parse(row.conversation_quality as string)
        : (row.conversation_quality as ConversationQualityResults))
      : null,
    createdAt: String(row.created_at),
  };
}
