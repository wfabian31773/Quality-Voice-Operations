import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  createScenario,
  updateScenario,
  deleteScenario,
  listScenarios,
  getScenario,
  seedDefaultScenarios,
  createSimulationRun,
  getSimulationRun,
  listSimulationRuns,
  getSimulationResults,
  getSimulationResult,
  executeSimulationRun,
  compareSimulationRuns,
  CallerPersona,
  ExpectedOutcomes,
} from '../../../platform/simulation/SimulationEngine';

function validateCallerPersona(obj: unknown): CallerPersona | null {
  if (!obj || typeof obj !== 'object') return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.name !== 'string' || typeof p.mood !== 'string' ||
      typeof p.background !== 'string' || typeof p.speakingStyle !== 'string' ||
      typeof p.urgency !== 'string') {
    return null;
  }
  return { name: p.name, mood: p.mood, background: p.background, speakingStyle: p.speakingStyle, urgency: p.urgency };
}

function validateExpectedOutcomes(obj: unknown): ExpectedOutcomes | null {
  if (!obj || typeof obj !== 'object') return null;
  const e = obj as Record<string, unknown>;
  if (typeof e.shouldBook !== 'boolean' || typeof e.shouldEscalate !== 'boolean' ||
      typeof e.shouldResolve !== 'boolean' || typeof e.expectedIntent !== 'string' ||
      !Array.isArray(e.acceptableEndStates)) {
    return null;
  }
  return {
    shouldBook: e.shouldBook, shouldEscalate: e.shouldEscalate,
    shouldResolve: e.shouldResolve, expectedIntent: e.expectedIntent,
    acceptableEndStates: e.acceptableEndStates.map(String),
  };
}

const router = Router();
const logger = createLogger('ADMIN_SIMULATIONS');

router.get('/simulations/scenarios', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const category = req.query.category as string | undefined;
  try {
    await seedDefaultScenarios(tenantId);
    const scenarios = await listScenarios(tenantId, category);
    return res.json({ scenarios });
  } catch (err) {
    logger.error('Failed to list scenarios', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list scenarios' });
  }
});

router.get('/simulations/scenarios/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const scenario = await getScenario(tenantId, req.params.id);
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
    return res.json({ scenario });
  } catch (err) {
    logger.error('Failed to get scenario', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get scenario' });
  }
});

router.post('/simulations/scenarios', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;

  if (!body.name || !body.persona || !body.goals || !body.expectedOutcomes) {
    return res.status(400).json({ error: 'name, persona, goals, and expectedOutcomes are required' });
  }

  const persona = validateCallerPersona(body.persona);
  if (!persona) {
    return res.status(400).json({ error: 'persona must include name, mood, background, speakingStyle, and urgency as strings' });
  }
  const expectedOutcomes = validateExpectedOutcomes(body.expectedOutcomes);
  if (!expectedOutcomes) {
    return res.status(400).json({ error: 'expectedOutcomes must include shouldBook, shouldEscalate, shouldResolve (booleans), expectedIntent (string), and acceptableEndStates (string[])' });
  }
  if (!Array.isArray(body.goals) || body.goals.some((g: unknown) => typeof g !== 'string')) {
    return res.status(400).json({ error: 'goals must be an array of strings' });
  }

  try {
    const scenario = await createScenario(tenantId, {
      name: body.name as string,
      description: body.description as string | undefined,
      category: body.category as string | undefined,
      persona,
      goals: body.goals as string[],
      expectedOutcomes,
      difficulty: body.difficulty as string | undefined,
      maxTurns: body.maxTurns as number | undefined,
    });
    return res.status(201).json({ scenario });
  } catch (err) {
    logger.error('Failed to create scenario', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create scenario' });
  }
});

router.patch('/simulations/scenarios/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;

  if (body.persona !== undefined) {
    const persona = validateCallerPersona(body.persona);
    if (!persona) {
      return res.status(400).json({ error: 'persona must include name, mood, background, speakingStyle, and urgency as strings' });
    }
    body.persona = persona;
  }
  if (body.expectedOutcomes !== undefined) {
    const expectedOutcomes = validateExpectedOutcomes(body.expectedOutcomes);
    if (!expectedOutcomes) {
      return res.status(400).json({ error: 'expectedOutcomes must include shouldBook, shouldEscalate, shouldResolve (booleans), expectedIntent (string), and acceptableEndStates (string[])' });
    }
    body.expectedOutcomes = expectedOutcomes;
  }
  if (body.goals !== undefined) {
    if (!Array.isArray(body.goals) || body.goals.some((g: unknown) => typeof g !== 'string')) {
      return res.status(400).json({ error: 'goals must be an array of strings' });
    }
  }

  try {
    const scenario = await updateScenario(tenantId, req.params.id, body);
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
    return res.json({ scenario });
  } catch (err) {
    logger.error('Failed to update scenario', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update scenario' });
  }
});

router.delete('/simulations/scenarios/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const deleted = await deleteScenario(tenantId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Scenario not found or is a default scenario' });
    return res.json({ deleted: true });
  } catch (err) {
    logger.error('Failed to delete scenario', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete scenario' });
  }
});

router.get('/simulations/runs', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const agentId = req.query.agentId as string | undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const offset = (page - 1) * limit;

  try {
    const result = await listSimulationRuns(tenantId, agentId, limit, offset);
    return res.json({ runs: result.runs, total: result.total, limit, offset });
  } catch (err) {
    logger.error('Failed to list simulation runs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list simulation runs' });
  }
});

router.get('/simulations/runs/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const run = await getSimulationRun(tenantId, req.params.id);
    if (!run) return res.status(404).json({ error: 'Simulation run not found' });
    return res.json({ run });
  } catch (err) {
    logger.error('Failed to get simulation run', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get simulation run' });
  }
});

router.post('/simulations/runs', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;

  if (!body.agentId || !Array.isArray(body.scenarioIds) || body.scenarioIds.length === 0) {
    return res.status(400).json({ error: 'agentId and scenarioIds (non-empty array) are required' });
  }

  try {
    const run = await createSimulationRun(
      tenantId,
      body.agentId as string,
      body.scenarioIds as string[],
      body.name as string | undefined,
      body.promptVersionLabel as string | undefined,
    );

    executeSimulationRun(tenantId, run.id).catch((err) => {
      logger.error('Background simulation execution failed', { runId: run.id, error: String(err) });
    });

    return res.status(201).json({ run });
  } catch (err) {
    const msg = String(err);
    if (msg.includes('not found or does not belong to this tenant')) {
      return res.status(403).json({ error: msg.replace('Error: ', '') });
    }
    logger.error('Failed to create simulation run', { tenantId, error: msg });
    return res.status(500).json({ error: 'Failed to create simulation run' });
  }
});

router.get('/simulations/runs/:id/results', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const results = await getSimulationResults(tenantId, req.params.id);
    return res.json({ results });
  } catch (err) {
    logger.error('Failed to get simulation results', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get simulation results' });
  }
});

router.get('/simulations/results/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const result = await getSimulationResult(tenantId, req.params.id);
    if (!result) return res.status(404).json({ error: 'Simulation result not found' });
    return res.json({ result });
  } catch (err) {
    logger.error('Failed to get simulation result', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get simulation result' });
  }
});

router.post('/simulations/runs/compare', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;

  if (!Array.isArray(body.runIds) || body.runIds.length < 2) {
    return res.status(400).json({ error: 'runIds must be an array with at least 2 run IDs' });
  }

  try {
    const result = await compareSimulationRuns(tenantId, body.runIds as string[]);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to compare simulation runs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to compare simulation runs' });
  }
});

export default router;
