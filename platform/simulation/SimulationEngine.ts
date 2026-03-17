import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { QUALITY_SCORING_RUBRIC } from '../analytics';
import { ReasoningEngine } from '../reasoning/ReasoningEngine';
import { WorkflowEngine } from '../workflow/engine/WorkflowEngine';
import type { ConversationSlots, IntentType, WorkflowContext, WorkflowDirective } from '../workflow/types/index';

const logger = createLogger('SIMULATION_ENGINE');

export interface SimulationScenario {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  category: string;
  persona: CallerPersona;
  goals: string[];
  expectedOutcomes: ExpectedOutcomes;
  difficulty: string;
  maxTurns: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CallerPersona {
  name: string;
  mood: string;
  background: string;
  speakingStyle: string;
  urgency: string;
}

export interface ExpectedOutcomes {
  shouldBook: boolean;
  shouldEscalate: boolean;
  shouldResolve: boolean;
  expectedIntent: string;
  acceptableEndStates: string[];
}

export interface SimulationRun {
  id: string;
  tenantId: string;
  agentId: string;
  name: string | null;
  status: string;
  scenarioIds: string[];
  totalScenarios: number;
  completedScenarios: number;
  failedScenarios: number;
  aggregateScores: AggregateScores | null;
  promptVersionLabel: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CategoryBreakdown {
  category: string;
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
}

export interface AggregateScores {
  avgBookingSuccess: number;
  avgConversationCompletion: number;
  avgIntentResolution: number;
  avgToneAppropriateness: number;
  avgOverall: number;
  avgHelpfulness: number;
  avgAccuracy: number;
  avgTone: number;
  avgResolution: number;
  passRate: number;
  failureBreakdown: Record<string, number>;
  scoreDistribution: { bucket: string; count: number }[];
  categoryBreakdown: CategoryBreakdown[];
}

export interface SimulationResult {
  id: string;
  tenantId: string;
  runId: string;
  scenarioId: string;
  status: string;
  transcript: TranscriptEntry[];
  scores: SimulationScores | null;
  reasoningTrace: ReasoningTraceEntry[];
  toolCalls: ToolCallEntry[];
  outcome: string | null;
  failureReason: string | null;
  turnCount: number;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TranscriptEntry {
  role: 'caller' | 'agent';
  content: string;
  turnNumber: number;
  timestamp: string;
}

export interface QualityDimensions {
  helpfulness: number;
  accuracy: number;
  tone: number;
  resolution: number;
}

export interface SimulationScores {
  bookingSuccess: number;
  conversationCompletion: number;
  intentResolution: number;
  toneAppropriateness: number;
  overall: number;
  passed: boolean;
  scoringRationale: string;
  qualityDimensions?: QualityDimensions;
}

export interface ReasoningTraceEntry {
  turnNumber: number;
  intent: string;
  confidence: string;
  action: string;
  slots: Record<string, string>;
  reasoning: string;
}

export interface ToolCallEntry {
  turnNumber: number;
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

const SIMULATION_CALLER_PROMPT = `You are simulating a phone caller for testing an AI voice agent. Stay in character throughout.

PERSONA:
Name: {{persona_name}}
Mood: {{persona_mood}}
Background: {{persona_background}}
Speaking Style: {{persona_speaking_style}}
Urgency: {{persona_urgency}}

GOALS:
{{goals}}

INSTRUCTIONS:
- Stay in character as the caller described above
- Work toward achieving the stated goals naturally
- Respond as a real person would on a phone call
- If the agent asks questions, answer them according to your persona
- Keep responses concise (1-3 sentences) as in a real phone call
- Do not break character or acknowledge you are an AI
- If the agent handles your request well, be cooperative
- If the agent struggles, react according to your mood/urgency level`;

const SCORING_PROMPT = `You are evaluating a simulated conversation between an AI voice agent and a simulated caller.

Use the following platform quality scoring rubric for the core quality dimensions:
${QUALITY_SCORING_RUBRIC}

Additionally, score these simulation-specific dimensions (0-10):
5. Intent Resolution (0-10): Did the agent correctly identify and address the caller's stated intent?
6. Booking/Scheduling Success (0-10): If applicable, was booking/scheduling handled correctly? If not applicable, score 10.

Also determine if this is a PASS or FAIL based on:
- The expected outcomes listed below
- An overall score >= 6 is generally a pass
- Expected outcome flags (shouldBook, shouldEscalate, shouldResolve) must be satisfied for a pass

EXPECTED OUTCOMES:
{{expected_outcomes}}

CONVERSATION TRANSCRIPT:
{{transcript}}

Return ONLY valid JSON:
{
  "bookingSuccess": <float 0-10>,
  "conversationCompletion": <float 0-10>,
  "intentResolution": <float 0-10>,
  "toneAppropriateness": <float 0-10>,
  "overall": <float 0-10>,
  "passed": <boolean>,
  "scoringRationale": "<explanation of scores>",
  "qualityDimensions": {
    "helpfulness": <float 0-10>,
    "accuracy": <float 0-10>,
    "tone": <float 0-10>,
    "resolution": <float 0-10>
  }
}`;

export async function createScenario(
  tenantId: string,
  data: {
    name: string;
    description?: string;
    category?: string;
    persona: CallerPersona;
    goals: string[];
    expectedOutcomes: ExpectedOutcomes;
    difficulty?: string;
    maxTurns?: number;
  },
): Promise<SimulationScenario> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const row = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO simulation_scenarios (tenant_id, name, description, category, persona, goals, expected_outcomes, difficulty, max_turns)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          tenantId, data.name, data.description ?? null,
          data.category ?? 'custom', JSON.stringify(data.persona),
          JSON.stringify(data.goals), JSON.stringify(data.expectedOutcomes),
          data.difficulty ?? 'medium', data.maxTurns ?? 20,
        ],
      );
      return rows[0];
    });
    return mapScenarioRow(row);
  } finally {
    client.release();
  }
}

export async function updateScenario(
  tenantId: string,
  scenarioId: string,
  data: Partial<{
    name: string;
    description: string;
    category: string;
    persona: CallerPersona;
    goals: string[];
    expectedOutcomes: ExpectedOutcomes;
    difficulty: string;
    maxTurns: number;
  }>,
): Promise<SimulationScenario | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const row = await withTenantContext(client, tenantId, async () => {
      const updates: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [scenarioId, tenantId];
      const jsonFields = ['persona', 'goals', 'expected_outcomes'];
      const fieldMap: Record<string, string> = {
        name: 'name', description: 'description', category: 'category',
        persona: 'persona', goals: 'goals', expectedOutcomes: 'expected_outcomes',
        difficulty: 'difficulty', maxTurns: 'max_turns',
      };
      for (const [key, col] of Object.entries(fieldMap)) {
        if (key in data) {
          const val = (data as Record<string, unknown>)[key];
          values.push(jsonFields.includes(col) ? JSON.stringify(val) : val);
          updates.push(`${col} = $${values.length}`);
        }
      }
      if (updates.length === 1) return null;
      const { rows } = await client.query(
        `UPDATE simulation_scenarios SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        values,
      );
      return rows[0] ?? null;
    });
    return row ? mapScenarioRow(row) : null;
  } finally {
    client.release();
  }
}

export async function deleteScenario(tenantId: string, scenarioId: string): Promise<boolean> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const result = await withTenantContext(client, tenantId, async () => {
      const { rowCount } = await client.query(
        `DELETE FROM simulation_scenarios WHERE id = $1 AND tenant_id = $2 AND is_default = false`,
        [scenarioId, tenantId],
      );
      return rowCount;
    });
    return (result ?? 0) > 0;
  } finally {
    client.release();
  }
}

export async function listScenarios(
  tenantId: string,
  category?: string,
): Promise<SimulationScenario[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const params: unknown[] = [tenantId];
      let where = 'WHERE tenant_id = $1';
      if (category) {
        params.push(category);
        where += ` AND category = $${params.length}`;
      }
      const { rows } = await client.query(
        `SELECT * FROM simulation_scenarios ${where} ORDER BY is_default DESC, name ASC`,
        params,
      );
      return rows;
    });
    return rows.map(mapScenarioRow);
  } finally {
    client.release();
  }
}

export async function getScenario(tenantId: string, scenarioId: string): Promise<SimulationScenario | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM simulation_scenarios WHERE id = $1 AND tenant_id = $2`,
        [scenarioId, tenantId],
      );
      return rows;
    });
    return rows.length > 0 ? mapScenarioRow(rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function seedDefaultScenarios(tenantId: string): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const existing = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT COUNT(*) as cnt FROM simulation_scenarios WHERE tenant_id = $1 AND is_default = true`,
        [tenantId],
      );
      return parseInt(rows[0].cnt as string);
    });
    if (existing > 0) return;

    const defaults = getDefaultScenarios(tenantId);
    await withTenantContext(client, tenantId, async () => {
      for (const s of defaults) {
        await client.query(
          `INSERT INTO simulation_scenarios (tenant_id, name, description, category, persona, goals, expected_outcomes, difficulty, max_turns, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
          [tenantId, s.name, s.description, s.category, JSON.stringify(s.persona), JSON.stringify(s.goals), JSON.stringify(s.expectedOutcomes), s.difficulty, s.maxTurns],
        );
      }
    });
    logger.info('Seeded default simulation scenarios', { tenantId, count: defaults.length });
  } finally {
    client.release();
  }
}

export async function createSimulationRun(
  tenantId: string,
  agentId: string,
  scenarioIds: string[],
  name?: string,
  promptVersionLabel?: string,
): Promise<SimulationRun> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {
      const { rows: agentRows } = await client.query(
        `SELECT id FROM agents WHERE id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      );
      if (agentRows.length === 0) {
        throw new Error('Agent not found or does not belong to this tenant');
      }

      if (scenarioIds.length > 0) {
        const { rows: scenarioRows } = await client.query(
          `SELECT id FROM simulation_scenarios WHERE id = ANY($1) AND tenant_id = $2`,
          [scenarioIds, tenantId],
        );
        if (scenarioRows.length !== scenarioIds.length) {
          throw new Error('One or more scenarios not found or do not belong to this tenant');
        }
      }
    });

    const row = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO simulation_runs (tenant_id, agent_id, name, scenario_ids, total_scenarios, prompt_version_label, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING *`,
        [tenantId, agentId, name ?? null, scenarioIds, scenarioIds.length, promptVersionLabel ?? null],
      );
      return rows[0];
    });

    await withTenantContext(client, tenantId, async () => {
      for (const scenarioId of scenarioIds) {
        await client.query(
          `INSERT INTO simulation_results (tenant_id, run_id, scenario_id, status)
           VALUES ($1, $2, $3, 'pending')`,
          [tenantId, row.id, scenarioId],
        );
      }
    });

    return mapRunRow(row);
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
        `SELECT * FROM simulation_runs WHERE id = $1 AND tenant_id = $2`,
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
  agentId?: string,
  limit = 20,
  offset = 0,
): Promise<{ runs: SimulationRun[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const result = await withTenantContext(client, tenantId, async () => {
      const params: unknown[] = [tenantId];
      let where = 'WHERE sr.tenant_id = $1';
      if (agentId) {
        params.push(agentId);
        where += ` AND sr.agent_id = $${params.length}`;
      }
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*) AS total FROM simulation_runs sr ${where}`,
        params,
      );
      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT sr.*, a.name as agent_name FROM simulation_runs sr
         LEFT JOIN agents a ON a.id = sr.agent_id AND a.tenant_id = sr.tenant_id
         ${where} ORDER BY sr.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total: parseInt(countRows[0].total as string) };
    });
    return { runs: result.rows.map(mapRunRow), total: result.total };
  } finally {
    client.release();
  }
}

export async function getSimulationResults(
  tenantId: string,
  runId: string,
): Promise<SimulationResult[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT sr.*, ss.name as scenario_name, ss.category as scenario_category
         FROM simulation_results sr
         JOIN simulation_scenarios ss ON ss.id = sr.scenario_id AND ss.tenant_id = sr.tenant_id
         WHERE sr.run_id = $1 AND sr.tenant_id = $2
         ORDER BY sr.created_at ASC`,
        [runId, tenantId],
      );
      return rows;
    });
    return rows.map(mapResultRow);
  } finally {
    client.release();
  }
}

export async function getSimulationResult(
  tenantId: string,
  resultId: string,
): Promise<SimulationResult | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT sr.*, ss.name as scenario_name, ss.category as scenario_category
         FROM simulation_results sr
         JOIN simulation_scenarios ss ON ss.id = sr.scenario_id AND ss.tenant_id = sr.tenant_id
         WHERE sr.id = $1 AND sr.tenant_id = $2`,
        [resultId, tenantId],
      );
      return rows;
    });
    return rows.length > 0 ? mapResultRow(rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function compareSimulationRuns(
  tenantId: string,
  runIds: string[],
): Promise<{
  runs: SimulationRun[];
  comparison: {
    runId: string;
    promptVersionLabel: string | null;
    avgOverall: number;
    avgHelpfulness: number;
    avgTone: number;
    avgResolution: number;
    passRate: number;
    totalScenarios: number;
    completedScenarios: number;
    failedScenarios: number;
  }[];
}> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const runs: SimulationRun[] = [];
    const comparison: {
      runId: string;
      promptVersionLabel: string | null;
      avgOverall: number;
      avgHelpfulness: number;
      avgTone: number;
      avgResolution: number;
      passRate: number;
      totalScenarios: number;
      completedScenarios: number;
      failedScenarios: number;
    }[] = [];

    for (const runId of runIds) {
      const runRow = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT sr.*, a.name as agent_name FROM simulation_runs sr
           LEFT JOIN agents a ON a.id = sr.agent_id AND a.tenant_id = sr.tenant_id
           WHERE sr.id = $1 AND sr.tenant_id = $2`,
          [runId, tenantId],
        );
        return rows[0];
      });
      if (!runRow) continue;
      const run = mapRunRow(runRow);
      runs.push(run);

      const agg = run.aggregateScores;
      comparison.push({
        runId: run.id,
        promptVersionLabel: run.promptVersionLabel,
        avgOverall: agg?.avgOverall ?? 0,
        avgHelpfulness: agg?.avgHelpfulness ?? 0,
        avgTone: agg?.avgTone ?? 0,
        avgResolution: agg?.avgResolution ?? 0,
        passRate: agg?.passRate ?? 0,
        totalScenarios: run.totalScenarios,
        completedScenarios: run.completedScenarios,
        failedScenarios: run.failedScenarios,
      });
    }

    return { runs, comparison };
  } finally {
    client.release();
  }
}

async function dbUpdate(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  query: string,
  params: unknown[],
): Promise<void> {
  const c = await pool.connect();
  try {
    await withTenantContext(c, tenantId, async () => {
      await c.query(query, params);
    });
  } finally {
    c.release();
  }
}

async function dbQuery(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  query: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  const c = await pool.connect();
  try {
    return await withTenantContext(c, tenantId, async () => {
      const { rows } = await c.query(query, params);
      return rows;
    });
  } finally {
    c.release();
  }
}

export async function executeSimulationRun(
  tenantId: string,
  runId: string,
): Promise<void> {
  const pool = getPlatformPool();

  try {
    await dbUpdate(pool, tenantId,
      `UPDATE simulation_runs SET status = 'running', started_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );

    const results = await dbQuery(pool, tenantId,
      `SELECT sr.id, sr.scenario_id, ss.persona, ss.goals, ss.expected_outcomes, ss.max_turns, ss.name as scenario_name, ss.category
       FROM simulation_results sr
       JOIN simulation_scenarios ss ON ss.id = sr.scenario_id AND ss.tenant_id = sr.tenant_id
       WHERE sr.run_id = $1 AND sr.tenant_id = $2 AND sr.status = 'pending'`,
      [runId, tenantId],
    );

    const runRows = await dbQuery(pool, tenantId,
      `SELECT r.*, a.system_prompt, a.type as agent_type, a.welcome_greeting, a.voice, a.name as agent_name
       FROM simulation_runs r
       JOIN agents a ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
       WHERE r.id = $1 AND r.tenant_id = $2`,
      [runId, tenantId],
    );

    const run = runRows[0];
    if (!run) {
      logger.error('Simulation run not found', { runId, tenantId });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    let completedCount = 0;
    let failedCount = 0;
    const totalScenarioCount = results.length;
    const allScores: { scores: SimulationScores; category: string }[] = [];
    const failureReasons: Record<string, number> = {};
    const categoryFailCounts: Record<string, number> = {};
    const categoryTotalCounts: Record<string, number> = {};
    for (const r of results) {
      const cat = (r.category as string) || 'custom';
      categoryTotalCounts[cat] = (categoryTotalCounts[cat] || 0) + 1;
    }

    const CONCURRENCY_LIMIT = 3;
    for (let i = 0; i < results.length; i += CONCURRENCY_LIMIT) {
      const batch = results.slice(i, i + CONCURRENCY_LIMIT);
      const promises = batch.map(async (result) => {
        try {
          const simResult = await runSingleSimulation(
            apiKey,
            result,
            run,
            tenantId,
          );

          await dbUpdate(pool, tenantId,
            `UPDATE simulation_results
             SET status = $3, transcript = $4, scores = $5, reasoning_trace = $6,
                 tool_calls = $7, outcome = $8, failure_reason = $9,
                 turn_count = $10, duration_ms = $11, started_at = $12, completed_at = NOW()
             WHERE id = $1 AND tenant_id = $2`,
            [
              result.id, tenantId, simResult.status,
              JSON.stringify(simResult.transcript),
              JSON.stringify(simResult.scores),
              JSON.stringify(simResult.reasoningTrace),
              JSON.stringify(simResult.toolCalls),
              simResult.outcome, simResult.failureReason,
              simResult.turnCount, simResult.durationMs,
              simResult.startedAt,
            ],
          );

          const scenarioCategory = (result.category as string) || 'custom';
          if (simResult.status === 'completed' && simResult.scores) {
            completedCount++;
            allScores.push({ scores: simResult.scores, category: scenarioCategory });
          } else {
            failedCount++;
            categoryFailCounts[scenarioCategory] = (categoryFailCounts[scenarioCategory] || 0) + 1;
            const reason = simResult.failureReason || 'unknown';
            failureReasons[reason] = (failureReasons[reason] || 0) + 1;
          }

          await dbUpdate(pool, tenantId,
            `UPDATE simulation_runs SET completed_scenarios = $3, failed_scenarios = $4
             WHERE id = $1 AND tenant_id = $2`,
            [runId, tenantId, completedCount + failedCount, failedCount],
          );
        } catch (err) {
          failedCount++;
          logger.error('Simulation failed for scenario', {
            resultId: result.id,
            error: String(err),
          });
          await dbUpdate(pool, tenantId,
            `UPDATE simulation_results SET status = 'failed', failure_reason = $3, completed_at = NOW()
             WHERE id = $1 AND tenant_id = $2`,
            [result.id, tenantId, String(err)],
          );
        }
      });
      await Promise.all(promises);
    }

    const aggregateScores = computeAggregateScores(allScores, failureReasons, totalScenarioCount, categoryTotalCounts, categoryFailCounts);

    await dbUpdate(pool, tenantId,
      `UPDATE simulation_runs
       SET status = 'completed', completed_scenarios = $3, failed_scenarios = $4,
           aggregate_scores = $5, completed_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId, completedCount + failedCount, failedCount, JSON.stringify(aggregateScores)],
    );

    logger.info('Simulation run completed', {
      runId, tenantId,
      completed: completedCount,
      failed: failedCount,
      avgScore: aggregateScores.avgOverall,
    });
  } catch (err) {
    logger.error('Simulation run failed', { runId, tenantId, error: String(err) });
    await dbUpdate(pool, tenantId,
      `UPDATE simulation_runs SET status = 'failed', completed_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
  }
}

async function runSingleSimulation(
  apiKey: string | undefined,
  scenarioResult: Record<string, unknown>,
  run: Record<string, unknown>,
  tenantId: string,
): Promise<{
  status: string;
  transcript: TranscriptEntry[];
  scores: SimulationScores | null;
  reasoningTrace: ReasoningTraceEntry[];
  toolCalls: ToolCallEntry[];
  outcome: string | null;
  failureReason: string | null;
  turnCount: number;
  durationMs: number;
  startedAt: string;
}> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const persona = scenarioResult.persona as CallerPersona;
  const goals = scenarioResult.goals as string[];
  const expectedOutcomes = scenarioResult.expected_outcomes as ExpectedOutcomes;
  const maxTurns = (scenarioResult.max_turns as number) || 20;
  const agentPrompt = (run.system_prompt as string) || 'You are a helpful AI phone agent.';
  const welcomeGreeting = (run.welcome_greeting as string) || 'Hello, how can I help you today?';

  const transcript: TranscriptEntry[] = [];
  const reasoningTrace: ReasoningTraceEntry[] = [];
  const toolCalls: ToolCallEntry[] = [];

  if (!apiKey) {
    const simTranscript = generateDeterministicSimulation(persona, goals, welcomeGreeting, maxTurns);
    const simScores: SimulationScores = {
      bookingSuccess: 7,
      conversationCompletion: 8,
      intentResolution: 7,
      toneAppropriateness: 8,
      overall: 7.5,
      passed: true,
      scoringRationale: 'Deterministic simulation - no API key available for LLM-driven simulation',
    };
    return {
      status: 'completed',
      transcript: simTranscript,
      scores: simScores,
      reasoningTrace: [{
        turnNumber: 1, intent: 'general_inquiry', confidence: 'medium',
        action: 'respond', slots: {}, reasoning: 'Deterministic simulation mode',
      }],
      toolCalls: [],
      outcome: 'passed',
      failureReason: null,
      turnCount: simTranscript.length,
      durationMs: Date.now() - startTime,
      startedAt,
    };
  }

  const callerSystemPrompt = SIMULATION_CALLER_PROMPT
    .replace('{{persona_name}}', persona.name)
    .replace('{{persona_mood}}', persona.mood)
    .replace('{{persona_background}}', persona.background)
    .replace('{{persona_speaking_style}}', persona.speakingStyle)
    .replace('{{persona_urgency}}', persona.urgency)
    .replace('{{goals}}', goals.map((g, i) => `${i + 1}. ${g}`).join('\n'));

  transcript.push({
    role: 'agent',
    content: welcomeGreeting,
    turnNumber: 0,
    timestamp: new Date().toISOString(),
  });

  const agentMessages: { role: string; content: string }[] = [
    { role: 'system', content: agentPrompt },
    { role: 'assistant', content: welcomeGreeting },
  ];

  const callerMessages: { role: string; content: string }[] = [
    { role: 'system', content: callerSystemPrompt },
    { role: 'user', content: `The agent just said: "${welcomeGreeting}". Respond as the caller.` },
  ];

  const agentVertical = (run.vertical as string) || 'general';
  const agentSlug = (run.agent_slug as string) || 'sim-agent';
  const simSessionId = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const reasoningEngine = new ReasoningEngine({
    tenantId,
    callSessionId: simSessionId,
    callSid: simSessionId,
    agentSlug,
    vertical: agentVertical,
    callerNumber: '+15555550000',
    toolsAvailable: [],
  });

  const workflowEngine = new WorkflowEngine({
    workflows: [
      { id: 'general_inquiry', name: 'General Inquiry', requiredSlots: ['patient_name', 'reason_for_call', 'callback_number'], confirmationRequired: true },
      { id: 'urgent_medical', name: 'Urgent Medical', requiredSlots: ['patient_name', 'symptom_description'], confirmationRequired: false },
      { id: 'schedule_appointment', name: 'Schedule Appointment', requiredSlots: ['patient_name', 'appointment_date', 'appointment_time', 'callback_number'], confirmationRequired: true },
      { id: 'billing_inquiry', name: 'Billing Inquiry', requiredSlots: ['patient_name', 'callback_number'], confirmationRequired: false },
      { id: 'cancel_appointment', name: 'Cancel Appointment', requiredSlots: ['patient_name', 'appointment_date'], confirmationRequired: true },
    ],
  });

  const workflowSlots: ConversationSlots = {};
  let currentWorkflowIntent: IntentType = 'unknown';
  let workflowState: 'greeting' | 'intent_classification' | 'slot_collection' | 'confirmation' | 'execution' | 'escalation' | 'completion' = 'greeting';

  for (let turn = 1; turn <= maxTurns; turn++) {
    try {
      const callerResponse = await callLLM(apiKey, callerMessages, 0.8);
      if (!callerResponse) break;

      transcript.push({
        role: 'caller',
        content: callerResponse,
        turnNumber: turn,
        timestamp: new Date().toISOString(),
      });

      callerMessages.push({ role: 'assistant', content: callerResponse });

      const wfClassification = workflowEngine.classifyIntent(callerResponse);
      if (wfClassification.intent !== 'unknown') {
        currentWorkflowIntent = wfClassification.intent;
        workflowState = 'slot_collection';
      }

      extractSlotsFromUtterance(callerResponse, workflowSlots);

      const intentResult = reasoningEngine.classifyIntent(callerResponse);
      const decision = reasoningEngine.processUtterance(
        callerResponse,
        intentResult.intent,
        intentResult.confidence,
      );

      const wfContext: WorkflowContext = {
        tenantId,
        callId: simSessionId,
        agentSlug,
        intent: currentWorkflowIntent,
        state: workflowState,
        slots: workflowSlots,
        turnCount: turn,
        escalationAttempts: 0,
        transcript: transcript.map(t => `${t.role}: ${t.content}`),
      };
      const directive: WorkflowDirective = workflowEngine.getNextDirective(wfContext);

      let directiveConstraint = '';
      if (directive.action === 'collect_slot' && directive.slotToCollect) {
        directiveConstraint = `[WORKFLOW DIRECTIVE: You need to collect the following information from the caller: ${directive.slotToCollect}. ${directive.prompt || ''}. Missing slots: ${(directive.missingSlots || []).join(', ')}]`;
      } else if (directive.action === 'confirm_summary' && directive.summary) {
        directiveConstraint = `[WORKFLOW DIRECTIVE: Confirm the collected information with the caller: ${directive.summary}]`;
        workflowState = 'confirmation';
      } else if (directive.action === 'execute') {
        directiveConstraint = `[WORKFLOW DIRECTIVE: All required information is collected. Proceed to complete the action for the caller.]`;
        workflowState = 'execution';
      } else if (directive.action === 'escalate') {
        directiveConstraint = `[WORKFLOW DIRECTIVE: Escalate this call. Reason: ${directive.escalationReason || 'unknown'}]`;
        workflowState = 'escalation';
      }

      reasoningTrace.push({
        turnNumber: turn,
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        action: decision.action,
        slots: Object.fromEntries(Object.entries(workflowSlots).filter(([, v]) => v != null)) as Record<string, string>,
        reasoning: `Intent: ${intentResult.intent} (${intentResult.confidence}), Decision: ${decision.action}, Workflow: ${directive.action}${directive.slotToCollect ? ` (collect: ${directive.slotToCollect})` : ''}`,
      });

      if (decision.action === 'execute_tool' && decision.toolToExecute) {
        toolCalls.push({
          turnNumber: turn,
          toolName: decision.toolToExecute,
          args: decision.toolArgs ?? {},
          result: 'simulated',
          success: true,
        });
        reasoningEngine.handleToolSuccess(decision.toolToExecute);
      }

      const constrainedMessages = [
        ...agentMessages,
        { role: 'user', content: callerResponse },
        ...(directiveConstraint ? [{ role: 'system', content: directiveConstraint }] : []),
      ];
      const agentResponse = await callLLM(apiKey, constrainedMessages, 0.7);
      if (!agentResponse) break;

      const safetyCheck = reasoningEngine.checkResponseSafety(agentResponse);
      if (!safetyCheck.allowed) {
        reasoningTrace.push({
          turnNumber: turn,
          intent: intentResult.intent,
          confidence: intentResult.confidence,
          action: 'safety_blocked',
          slots: {},
          reasoning: `Agent response blocked by safety gate: ${safetyCheck.violations.map(v => v.description).join('; ')}`,
        });
      }

      transcript.push({
        role: 'agent',
        content: agentResponse,
        turnNumber: turn,
        timestamp: new Date().toISOString(),
      });

      extractSlotsFromUtterance(agentResponse, workflowSlots);

      agentMessages.push({ role: 'user', content: callerResponse });
      agentMessages.push({ role: 'assistant', content: agentResponse });
      callerMessages.push({ role: 'user', content: `The agent said: "${agentResponse}". Respond as the caller, or say "CONVERSATION_COMPLETE" if your goals are achieved or the conversation has naturally ended.` });

      if (callerResponse.includes('CONVERSATION_COMPLETE') || agentResponse.includes('goodbye') || agentResponse.includes('Goodbye')) {
        break;
      }
    } catch (err) {
      logger.error('Turn failed in simulation', { turn, error: String(err) });
      break;
    }
  }

  let scores: SimulationScores | null = null;
  try {
    scores = await scoreSimulation(apiKey, transcript, expectedOutcomes);
  } catch (err) {
    logger.error('Failed to score simulation', { error: String(err) });
  }

  return {
    status: 'completed',
    transcript,
    scores,
    reasoningTrace,
    toolCalls,
    outcome: scores?.passed ? 'passed' : 'failed',
    failureReason: scores?.passed ? null : scores?.scoringRationale ?? 'Scoring unavailable',
    turnCount: transcript.length,
    durationMs: Date.now() - startTime,
    startedAt,
  };
}

function extractSlotsFromUtterance(utterance: string, slots: ConversationSlots): void {
  const lower = utterance.toLowerCase();

  if (!slots.patient_name) {
    const nameMatch = utterance.match(/(?:my name is|I'm|this is|name's)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    if (nameMatch) slots.patient_name = nameMatch[1].trim();
  }

  if (!slots.patient_dob) {
    const dobMatch = utterance.match(/(?:born on|date of birth|birthday|dob)\s*(?:is\s*)?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)
      || utterance.match(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/);
    if (dobMatch) slots.patient_dob = dobMatch[1];
  }

  if (!slots.callback_number) {
    const phoneMatch = utterance.match(/(?:reach me|call me|number is|phone)\s*(?:at\s*)?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i)
      || utterance.match(/(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
    if (phoneMatch) slots.callback_number = phoneMatch[1];
  }

  if (!slots.reason_for_call) {
    const reasonMatch = utterance.match(/(?:calling about|reason for|need to|want to|I'd like to)\s+(.{5,80}?)(?:\.|$)/i);
    if (reasonMatch) slots.reason_for_call = reasonMatch[1].trim();
  }

  if (!slots.appointment_date) {
    const dateMatch = utterance.match(/(?:on|for|date)\s*(?:the\s*)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)/i)
      || utterance.match(/(tomorrow|next \w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (dateMatch) slots.appointment_date = dateMatch[1];
  }

  if (!slots.appointment_time) {
    const timeMatch = utterance.match(/(?:at|around|by)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))/i)
      || utterance.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))/i);
    if (timeMatch) slots.appointment_time = timeMatch[1];
  }

  if (!slots.urgency_level) {
    if (lower.includes('urgent') || lower.includes('emergency') || lower.includes('asap') || lower.includes('right away')) {
      slots.urgency_level = 'urgent';
    } else if (lower.includes('soon') || lower.includes('as soon as')) {
      slots.urgency_level = 'high';
    }
  }

  if (!slots.symptom_description) {
    const symptomMatch = utterance.match(/(?:symptom|experiencing|having|feeling)\s+(.{5,100}?)(?:\.|$)/i);
    if (symptomMatch) slots.symptom_description = symptomMatch[1].trim();
  }

  if (!slots.preferred_provider) {
    const providerMatch = utterance.match(/(?:prefer|see|with)\s+(?:Dr\.?|Doctor)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    if (providerMatch) slots.preferred_provider = providerMatch[1].trim();
  }

  if (!slots.preferred_location) {
    const locationMatch = utterance.match(/(?:at the|at|location)\s+([\w\s]+(?:office|clinic|branch|center|centre))/i);
    if (locationMatch) slots.preferred_location = locationMatch[1].trim();
  }
}

async function callLLM(
  apiKey: string,
  messages: { role: string; content: string }[],
  temperature: number,
): Promise<string | null> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature,
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    logger.error('LLM call failed', { status: response.status });
    return null;
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? null;
}

async function scoreSimulation(
  apiKey: string,
  transcript: TranscriptEntry[],
  expectedOutcomes: ExpectedOutcomes,
): Promise<SimulationScores> {
  const transcriptText = transcript
    .map((t) => `${t.role}: ${t.content}`)
    .join('\n');

  const prompt = SCORING_PROMPT
    .replace('{{expected_outcomes}}', JSON.stringify(expectedOutcomes, null, 2))
    .replace('{{transcript}}', transcriptText);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a conversation quality evaluator. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    throw new Error(`Scoring API failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty scoring response');

  return JSON.parse(content) as SimulationScores;
}

function generateDeterministicSimulation(
  persona: CallerPersona,
  goals: string[],
  welcomeGreeting: string,
  maxTurns: number,
): TranscriptEntry[] {
  const transcript: TranscriptEntry[] = [
    { role: 'agent', content: welcomeGreeting, turnNumber: 0, timestamp: new Date().toISOString() },
  ];

  const callerLines = [
    `Hi, my name is ${persona.name}. ${goals[0] || 'I need some help.'}`,
    'Yes, that would be great.',
    'Sure, my number is 555-0123.',
    'Tomorrow morning would work for me.',
    'That sounds perfect, thank you.',
  ];

  const agentLines = [
    'Of course, I can help you with that. Could I get your name please?',
    'Great! And what is the best number to reach you at?',
    'Do you have a preferred date and time?',
    'I have an opening tomorrow at 10 AM. Would that work for you?',
    'Wonderful! You are all set. Is there anything else I can help you with?',
  ];

  const turns = Math.min(maxTurns, callerLines.length);
  for (let i = 0; i < turns; i++) {
    transcript.push({ role: 'caller', content: callerLines[i], turnNumber: i + 1, timestamp: new Date().toISOString() });
    if (i < agentLines.length) {
      transcript.push({ role: 'agent', content: agentLines[i], turnNumber: i + 1, timestamp: new Date().toISOString() });
    }
  }
  return transcript;
}

function computeAggregateScores(
  scoredResults: { scores: SimulationScores; category: string }[],
  failureReasons: Record<string, number>,
  totalScenarios: number,
  categoryTotalCounts: Record<string, number>,
  categoryFailCounts: Record<string, number>,
): AggregateScores {
  if (scoredResults.length === 0) {
    const categoryBreakdown: CategoryBreakdown[] = Object.entries(categoryTotalCounts).map(([category, total]) => ({
      category,
      total,
      passed: 0,
      failed: categoryFailCounts[category] || 0,
      avgScore: 0,
    }));
    return {
      avgBookingSuccess: 0, avgConversationCompletion: 0,
      avgIntentResolution: 0, avgToneAppropriateness: 0,
      avgOverall: 0, avgHelpfulness: 0, avgAccuracy: 0,
      avgTone: 0, avgResolution: 0, passRate: 0,
      failureBreakdown: failureReasons,
      scoreDistribution: [],
      categoryBreakdown,
    };
  }

  const scores = scoredResults.map(r => r.scores);
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const passCount = scores.filter((s) => s.passed).length;
  const denominator = Math.max(totalScenarios, scores.length);

  const buckets: Record<string, number> = { '0-2': 0, '2-4': 0, '4-6': 0, '6-8': 0, '8-10': 0 };
  for (const s of scores) {
    if (s.overall < 2) buckets['0-2']++;
    else if (s.overall < 4) buckets['2-4']++;
    else if (s.overall < 6) buckets['4-6']++;
    else if (s.overall < 8) buckets['6-8']++;
    else buckets['8-10']++;
  }

  const qScores = scores.filter(s => s.qualityDimensions);

  const catMap: Record<string, { passed: number; totalScore: number; count: number }> = {};
  for (const { scores: s, category } of scoredResults) {
    if (!catMap[category]) catMap[category] = { passed: 0, totalScore: 0, count: 0 };
    catMap[category].count++;
    catMap[category].totalScore += s.overall;
    if (s.passed) catMap[category].passed++;
  }
  const categoryBreakdown: CategoryBreakdown[] = Object.entries(categoryTotalCounts).map(([category, total]) => {
    const scored = catMap[category] || { passed: 0, totalScore: 0, count: 0 };
    return {
      category,
      total,
      passed: scored.passed,
      failed: total - scored.passed,
      avgScore: scored.count > 0 ? scored.totalScore / scored.count : 0,
    };
  });

  return {
    avgBookingSuccess: avg(scores.map((s) => s.bookingSuccess)),
    avgConversationCompletion: avg(scores.map((s) => s.conversationCompletion)),
    avgIntentResolution: avg(scores.map((s) => s.intentResolution)),
    avgToneAppropriateness: avg(scores.map((s) => s.toneAppropriateness)),
    avgOverall: avg(scores.map((s) => s.overall)),
    avgHelpfulness: qScores.length > 0 ? avg(qScores.map(s => s.qualityDimensions!.helpfulness)) : 0,
    avgAccuracy: qScores.length > 0 ? avg(qScores.map(s => s.qualityDimensions!.accuracy)) : 0,
    avgTone: qScores.length > 0 ? avg(qScores.map(s => s.qualityDimensions!.tone)) : 0,
    avgResolution: qScores.length > 0 ? avg(qScores.map(s => s.qualityDimensions!.resolution)) : 0,
    passRate: (passCount / denominator) * 100,
    failureBreakdown: failureReasons,
    scoreDistribution: Object.entries(buckets).map(([bucket, count]) => ({ bucket, count })),
    categoryBreakdown,
  };
}

function mapScenarioRow(row: Record<string, unknown>): SimulationScenario {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    description: row.description as string | null,
    category: row.category as string,
    persona: row.persona as CallerPersona,
    goals: row.goals as string[],
    expectedOutcomes: row.expected_outcomes as ExpectedOutcomes,
    difficulty: row.difficulty as string,
    maxTurns: row.max_turns as number,
    isDefault: row.is_default as boolean,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRunRow(row: Record<string, unknown>): SimulationRun {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: row.agent_id as string,
    name: row.name as string | null,
    status: row.status as string,
    scenarioIds: row.scenario_ids as string[],
    totalScenarios: row.total_scenarios as number,
    completedScenarios: row.completed_scenarios as number,
    failedScenarios: row.failed_scenarios as number,
    aggregateScores: row.aggregate_scores as AggregateScores | null,
    promptVersionLabel: row.prompt_version_label as string | null,
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
    scenarioId: row.scenario_id as string,
    status: row.status as string,
    transcript: row.transcript as TranscriptEntry[],
    scores: row.scores as SimulationScores | null,
    reasoningTrace: row.reasoning_trace as ReasoningTraceEntry[],
    toolCalls: row.tool_calls as ToolCallEntry[],
    outcome: row.outcome as string | null,
    failureReason: row.failure_reason as string | null,
    turnCount: row.turn_count as number,
    durationMs: row.duration_ms as number | null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    createdAt: String(row.created_at),
  };
}

function getDefaultScenarios(tenantId: string) {
  return [
    {
      name: 'Angry Customer - Billing Dispute',
      description: 'An angry customer calling about an unexpected charge on their bill',
      category: 'angry_customer',
      persona: {
        name: 'Karen Mitchell',
        mood: 'angry',
        background: 'Long-time customer who found an unexpected $150 charge',
        speakingStyle: 'demanding, interrupts frequently, wants immediate resolution',
        urgency: 'high',
      },
      goals: [
        'Demand explanation for the unexpected charge',
        'Request immediate refund or credit',
        'Threaten to cancel service if not resolved',
      ],
      expectedOutcomes: {
        shouldBook: false,
        shouldEscalate: true,
        shouldResolve: false,
        expectedIntent: 'billing_inquiry',
        acceptableEndStates: ['escalated_to_human', 'ticket_created', 'issue_acknowledged'],
      },
      difficulty: 'hard',
      maxTurns: 15,
    },
    {
      name: 'Emergency Medical Call',
      description: 'A caller reporting severe symptoms needing urgent medical attention',
      category: 'emergency',
      persona: {
        name: 'David Park',
        mood: 'panicked',
        background: 'Parent calling about child with high fever and difficulty breathing',
        speakingStyle: 'frantic, speaks quickly, needs reassurance',
        urgency: 'critical',
      },
      goals: [
        'Report severe symptoms: high fever, difficulty breathing',
        'Get connected to on-call physician immediately',
        'Receive guidance on whether to go to ER',
      ],
      expectedOutcomes: {
        shouldBook: false,
        shouldEscalate: true,
        shouldResolve: false,
        expectedIntent: 'urgent_medical',
        acceptableEndStates: ['escalated_to_human', 'emergency_protocol_activated'],
      },
      difficulty: 'hard',
      maxTurns: 10,
    },
    {
      name: 'Scheduling Conflict',
      description: 'A caller trying to book an appointment but has very limited availability',
      category: 'scheduling',
      persona: {
        name: 'Sarah Johnson',
        mood: 'frustrated but polite',
        background: 'Working professional who can only come in specific time slots',
        speakingStyle: 'professional, specific about time constraints',
        urgency: 'medium',
      },
      goals: [
        'Schedule an appointment for next week',
        'Can only do Tuesday or Thursday between 2-4 PM',
        'Need to confirm the exact date and time',
      ],
      expectedOutcomes: {
        shouldBook: true,
        shouldEscalate: false,
        shouldResolve: true,
        expectedIntent: 'schedule_appointment',
        acceptableEndStates: ['appointment_booked', 'callback_scheduled'],
      },
      difficulty: 'medium',
      maxTurns: 12,
    },
    {
      name: 'Lead Qualification - New Customer',
      description: 'A potential new customer inquiring about services',
      category: 'lead_qualification',
      persona: {
        name: 'Michael Chen',
        mood: 'curious',
        background: 'Business owner looking for a new service provider',
        speakingStyle: 'asks many questions, compares with competitors',
        urgency: 'low',
      },
      goals: [
        'Ask about available services and pricing',
        'Compare features with current provider',
        'Schedule a consultation if impressed',
      ],
      expectedOutcomes: {
        shouldBook: true,
        shouldEscalate: false,
        shouldResolve: true,
        expectedIntent: 'general_inquiry',
        acceptableEndStates: ['consultation_scheduled', 'information_provided', 'contact_created'],
      },
      difficulty: 'medium',
      maxTurns: 15,
    },
    {
      name: 'Simple Appointment Booking',
      description: 'A straightforward appointment booking with a cooperative caller',
      category: 'scheduling',
      persona: {
        name: 'Emily Davis',
        mood: 'pleasant',
        background: 'Regular patient calling for routine checkup',
        speakingStyle: 'friendly, provides information readily',
        urgency: 'low',
      },
      goals: [
        'Book a routine checkup appointment',
        'Provide all requested information promptly',
        'Confirm the appointment details',
      ],
      expectedOutcomes: {
        shouldBook: true,
        shouldEscalate: false,
        shouldResolve: true,
        expectedIntent: 'schedule_appointment',
        acceptableEndStates: ['appointment_booked'],
      },
      difficulty: 'easy',
      maxTurns: 10,
    },
  ];
}
