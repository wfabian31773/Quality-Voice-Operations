import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  createDigitalTwinModel,
  getDigitalTwinModel,
  listDigitalTwinModels,
  deleteDigitalTwinModel,
} from '../../../platform/digital-twin/DigitalTwinModelService';
import {
  createScenario,
  listScenarios,
  getScenario,
  runSimulation,
  getSimulationRun,
  listSimulationRuns,
  getSimulationResults,
  compareScenarios,
  seedPredefinedScenarios,
} from '../../../platform/digital-twin/OperationalSimulator';
import {
  generateForecast,
  getForecasts,
  getForecast,
} from '../../../platform/digital-twin/ForecastingService';
import { validateWithDigitalTwin } from '../../../platform/digital-twin/AutopilotIntegration';
import type { ForecastType } from '../../../platform/digital-twin/ForecastingService';

const router = Router();
const logger = createLogger('ADMIN_DIGITAL_TWIN');

router.post('/digital-twin/models', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { name, dataRangeStart, dataRangeEnd } = req.body;

  if (!name || typeof name !== 'string' || !dataRangeStart || !dataRangeEnd) {
    return res.status(400).json({ error: 'name, dataRangeStart, and dataRangeEnd are required' });
  }

  const startDate = new Date(dataRangeStart);
  const endDate = new Date(dataRangeEnd);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'dataRangeStart and dataRangeEnd must be valid dates' });
  }
  if (startDate >= endDate) {
    return res.status(400).json({ error: 'dataRangeStart must be before dataRangeEnd' });
  }

  try {
    const model = await createDigitalTwinModel(
      tenantId, name, startDate, endDate,
    );
    return res.status(201).json({ model });
  } catch (err) {
    logger.error('Failed to create digital twin model', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create digital twin model' });
  }
});

router.get('/digital-twin/models', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const models = await listDigitalTwinModels(tenantId);
    return res.json({ models });
  } catch (err) {
    logger.error('Failed to list digital twin models', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list models' });
  }
});

router.get('/digital-twin/models/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const model = await getDigitalTwinModel(tenantId, req.params.id);
    if (!model) return res.status(404).json({ error: 'Model not found' });
    return res.json({ model });
  } catch (err) {
    logger.error('Failed to get digital twin model', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get model' });
  }
});

router.delete('/digital-twin/models/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const deleted = await deleteDigitalTwinModel(tenantId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Model not found' });
    return res.json({ deleted: true });
  } catch (err) {
    logger.error('Failed to delete digital twin model', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete model' });
  }
});

router.get('/digital-twin/scenarios', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const category = req.query.category as string | undefined;
  try {
    await seedPredefinedScenarios().catch(() => {});
    const scenarios = await listScenarios(tenantId, category);
    return res.json({ scenarios });
  } catch (err) {
    logger.error('Failed to list scenarios', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list scenarios' });
  }
});

router.get('/digital-twin/scenarios/:id', requireAuth, async (req, res) => {
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

router.post('/digital-twin/scenarios', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, category, scenarioType, parameters } = req.body;

  if (!name || !parameters) {
    return res.status(400).json({ error: 'name and parameters are required' });
  }

  try {
    const scenario = await createScenario(tenantId, {
      name, description, category, scenarioType, parameters,
    });
    return res.status(201).json({ scenario });
  } catch (err) {
    logger.error('Failed to create scenario', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create scenario' });
  }
});

router.post('/digital-twin/simulate', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { modelId, scenarioId, name, parameters } = req.body;

  if (!modelId || !scenarioId) {
    return res.status(400).json({ error: 'modelId and scenarioId are required' });
  }

  try {
    const result = await runSimulation(tenantId, modelId, scenarioId, name, parameters);
    return res.status(201).json(result);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: msg.replace('Error: ', '') });
    }
    logger.error('Failed to run simulation', { tenantId, error: msg });
    return res.status(500).json({ error: 'Failed to run simulation' });
  }
});

router.get('/digital-twin/runs', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const modelId = req.query.modelId as string | undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  const offset = (page - 1) * limit;

  try {
    const result = await listSimulationRuns(tenantId, modelId, limit, offset);
    return res.json({ runs: result.runs, total: result.total, limit, offset });
  } catch (err) {
    logger.error('Failed to list simulation runs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list runs' });
  }
});

router.get('/digital-twin/runs/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const run = await getSimulationRun(tenantId, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    return res.json({ run });
  } catch (err) {
    logger.error('Failed to get simulation run', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get run' });
  }
});

router.get('/digital-twin/runs/:id/results', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const results = await getSimulationResults(tenantId, req.params.id);
    return res.json({ results });
  } catch (err) {
    logger.error('Failed to get simulation results', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get results' });
  }
});

router.post('/digital-twin/compare', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { runIds } = req.body;

  if (!Array.isArray(runIds) || runIds.length < 2) {
    return res.status(400).json({ error: 'runIds must be an array with at least 2 run IDs' });
  }

  try {
    const result = await compareScenarios(tenantId, runIds);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to compare scenarios', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to compare scenarios' });
  }
});

router.post('/digital-twin/forecasts', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { modelId, forecastType, horizonDays, confidenceLevel } = req.body;

  if (!modelId || !forecastType) {
    return res.status(400).json({ error: 'modelId and forecastType are required' });
  }

  const validTypes = ['call_volume', 'booking_rate', 'revenue', 'staffing_needs'];
  if (!validTypes.includes(forecastType)) {
    return res.status(400).json({ error: `forecastType must be one of: ${validTypes.join(', ')}` });
  }

  const parsedHorizon = parseInt(String(horizonDays ?? 30), 10);
  const parsedConfidence = parseFloat(String(confidenceLevel ?? 0.8));
  if (isNaN(parsedHorizon) || parsedHorizon < 1 || parsedHorizon > 365) {
    return res.status(400).json({ error: 'horizonDays must be between 1 and 365' });
  }
  if (isNaN(parsedConfidence) || parsedConfidence < 0.5 || parsedConfidence > 0.99) {
    return res.status(400).json({ error: 'confidenceLevel must be between 0.5 and 0.99' });
  }

  try {
    const forecast = await generateForecast(
      tenantId, modelId, forecastType as ForecastType,
      parsedHorizon, parsedConfidence,
    );
    return res.status(201).json({ forecast });
  } catch (err) {
    const msg = String(err);
    if (msg.includes('not found')) {
      return res.status(404).json({ error: msg.replace('Error: ', '') });
    }
    logger.error('Failed to generate forecast', { tenantId, error: msg });
    return res.status(500).json({ error: 'Failed to generate forecast' });
  }
});

router.get('/digital-twin/forecasts', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const modelId = req.query.modelId as string | undefined;
  const forecastType = req.query.forecastType as string | undefined;

  try {
    const forecasts = await getForecasts(tenantId, modelId, forecastType);
    return res.json({ forecasts });
  } catch (err) {
    logger.error('Failed to list forecasts', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list forecasts' });
  }
});

router.get('/digital-twin/forecasts/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const forecast = await getForecast(tenantId, req.params.id);
    if (!forecast) return res.status(404).json({ error: 'Forecast not found' });
    return res.json({ forecast });
  } catch (err) {
    logger.error('Failed to get forecast', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get forecast' });
  }
});

router.post('/digital-twin/validate', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { recommendationId, modelId, scenarioId, parameters } = req.body;

  if (!recommendationId || !modelId || !scenarioId) {
    return res.status(400).json({ error: 'recommendationId, modelId, and scenarioId are required' });
  }

  try {
    const result = await validateWithDigitalTwin(
      tenantId, recommendationId, modelId, scenarioId, parameters,
    );
    return res.json({ validation: result });
  } catch (err) {
    logger.error('Failed to validate with digital twin', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to validate recommendation' });
  }
});

export default router;
