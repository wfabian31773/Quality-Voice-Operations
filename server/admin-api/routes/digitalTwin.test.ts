import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => {
  const mk = (ns: string[]) => Object.fromEntries(ns.map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
  return {
    user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
    model: mk(['createDigitalTwinModel', 'getDigitalTwinModel', 'listDigitalTwinModels', 'deleteDigitalTwinModel']),
    sim: mk(['createScenario', 'listScenarios', 'getScenario', 'runSimulation', 'startSimulationAsync', 'getSimulationRun', 'listSimulationRuns', 'getSimulationResults', 'compareScenarios', 'seedPredefinedScenarios']),
    progress: mk(['getSimulationProgress', 'requestSimulationCancel']),
    forecast: mk(['generateForecast', 'getForecasts', 'getForecast']),
    autopilot: mk(['validateWithDigitalTwin']),
  };
});

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/digital-twin/DigitalTwinModelService', () => a.model);
vi.mock('../../../platform/digital-twin/OperationalSimulator', () => a.sim);
vi.mock('../../../platform/digital-twin/SimulationProgressTracker', () => a.progress);
vi.mock('../../../platform/digital-twin/ForecastingService', () => a.forecast);
vi.mock('../../../platform/digital-twin/AutopilotIntegration', () => a.autopilot);

import router from './digitalTwin';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  for (const grp of [a.model, a.sim, a.progress, a.forecast, a.autopilot]) {
    for (const fn of Object.values(grp)) fn.mockReset().mockResolvedValue({ ok: true });
  }
  a.sim.seedPredefinedScenarios.mockResolvedValue(undefined);
  a.progress.getSimulationProgress.mockReturnValue(null);
  a.progress.requestSimulationCancel.mockReturnValue(true);
});

describe('digital-twin models', () => {
  it('validates create input', async () => {
    expect((await request(app()).post('/digital-twin/models').send({ name: 'M' })).status).toBe(400);
    expect((await request(app()).post('/digital-twin/models').send({ name: 'M', dataRangeStart: 'bad', dataRangeEnd: 'bad' })).status).toBe(400);
    const res = await request(app()).post('/digital-twin/models').send({ name: 'M', dataRangeStart: '2026-02-01', dataRangeEnd: '2026-01-01' });
    expect(res.status).toBe(400);
  });
  it('creates a model', async () => {
    a.model.createDigitalTwinModel.mockResolvedValue({ id: 'm1' });
    const res = await request(app()).post('/digital-twin/models').send({ name: 'M', dataRangeStart: '2026-01-01', dataRangeEnd: '2026-02-01' });
    expect(res.status).toBe(201);
    expect(res.body.model).toMatchObject({ id: 'm1' });
  });
  it('lists models', async () => {
    a.model.listDigitalTwinModels.mockResolvedValue([{ id: 'm1' }]);
    expect((await request(app()).get('/digital-twin/models')).body.models).toHaveLength(1);
  });
  it('gets a model / 404', async () => {
    a.model.getDigitalTwinModel.mockResolvedValueOnce({ id: 'm1' });
    expect((await request(app()).get('/digital-twin/models/m1')).body.model).toMatchObject({ id: 'm1' });
    a.model.getDigitalTwinModel.mockResolvedValueOnce(null);
    expect((await request(app()).get('/digital-twin/models/x')).status).toBe(404);
  });
  it('deletes a model / 404', async () => {
    a.model.deleteDigitalTwinModel.mockResolvedValueOnce(true);
    expect((await request(app()).delete('/digital-twin/models/m1')).body).toEqual({ deleted: true });
    a.model.deleteDigitalTwinModel.mockResolvedValueOnce(false);
    expect((await request(app()).delete('/digital-twin/models/x')).status).toBe(404);
  });
});

describe('digital-twin scenarios', () => {
  it('lists scenarios (seeds predefined)', async () => {
    a.sim.listScenarios.mockResolvedValue([{ id: 's1' }]);
    expect((await request(app()).get('/digital-twin/scenarios')).body.scenarios).toHaveLength(1);
  });
  it('gets a scenario / 404', async () => {
    a.sim.getScenario.mockResolvedValueOnce(null);
    expect((await request(app()).get('/digital-twin/scenarios/x')).status).toBe(404);
  });
  it('creates a scenario (validation + success)', async () => {
    expect((await request(app()).post('/digital-twin/scenarios').send({ name: 'S' })).status).toBe(400);
    a.sim.createScenario.mockResolvedValue({ id: 's1' });
    const res = await request(app()).post('/digital-twin/scenarios').send({ name: 'S', parameters: {} });
    expect(res.status).toBe(201);
  });
});

describe('digital-twin simulate', () => {
  it('validates input', async () => {
    expect((await request(app()).post('/digital-twin/simulate').send({ modelId: 'm1' })).status).toBe(400);
  });
  it('runs sync (201) and async (202)', async () => {
    a.sim.runSimulation.mockResolvedValue({ runId: 'r1' });
    expect((await request(app()).post('/digital-twin/simulate').send({ modelId: 'm1', scenarioId: 's1' })).status).toBe(201);
    a.sim.startSimulationAsync.mockResolvedValue({ runId: 'r2', total: 10 });
    expect((await request(app()).post('/digital-twin/simulate').send({ modelId: 'm1', scenarioId: 's1', async: true })).status).toBe(202);
  });
  it('maps a not-found error to 404', async () => {
    a.sim.runSimulation.mockRejectedValue(new Error('Model not found'));
    expect((await request(app()).post('/digital-twin/simulate').send({ modelId: 'm1', scenarioId: 's1' })).status).toBe(404);
  });
});

describe('digital-twin runs', () => {
  it('returns run status (progress fallback)', async () => {
    a.sim.getSimulationRun.mockResolvedValue({ status: 'completed', tenantId: 't1' });
    const res = await request(app()).get('/digital-twin/runs/r1/status');
    expect(res.body).toMatchObject({ runId: 'r1', status: 'completed' });
  });
  it('404 on missing run status', async () => {
    a.sim.getSimulationRun.mockResolvedValue(null);
    expect((await request(app()).get('/digital-twin/runs/x/status')).status).toBe(404);
  });
  it('cancels a run (success / 409 / 404)', async () => {
    a.sim.getSimulationRun.mockResolvedValue({ tenantId: 't1' });
    a.progress.requestSimulationCancel.mockReturnValueOnce(true);
    expect((await request(app()).post('/digital-twin/runs/r1/cancel')).body).toMatchObject({ cancelRequested: true });
    a.progress.requestSimulationCancel.mockReturnValueOnce(false);
    expect((await request(app()).post('/digital-twin/runs/r1/cancel')).status).toBe(409);
    a.sim.getSimulationRun.mockResolvedValueOnce(null);
    expect((await request(app()).post('/digital-twin/runs/x/cancel')).status).toBe(404);
  });
  it('lists runs', async () => {
    a.sim.listSimulationRuns.mockResolvedValue({ runs: [{ id: 'r1' }], total: 1 });
    expect((await request(app()).get('/digital-twin/runs')).body.total).toBe(1);
  });
  it('gets a run / 404 and results', async () => {
    a.sim.getSimulationRun.mockResolvedValueOnce({ id: 'r1' });
    expect((await request(app()).get('/digital-twin/runs/r1')).body.run).toMatchObject({ id: 'r1' });
    a.sim.getSimulationResults.mockResolvedValue([{ metric: 1 }]);
    expect((await request(app()).get('/digital-twin/runs/r1/results')).body.results).toHaveLength(1);
  });
});

describe('digital-twin compare & forecasts', () => {
  it('compare validates runIds length', async () => {
    expect((await request(app()).post('/digital-twin/compare').send({ runIds: ['only-one'] })).status).toBe(400);
  });
  it('compares scenarios', async () => {
    a.sim.compareScenarios.mockResolvedValue({ diff: {} });
    expect((await request(app()).post('/digital-twin/compare').send({ runIds: ['r1', 'r2'] })).status).toBe(200);
  });
  it('forecast validates type/horizon/confidence', async () => {
    expect((await request(app()).post('/digital-twin/forecasts').send({ modelId: 'm1' })).status).toBe(400);
    expect((await request(app()).post('/digital-twin/forecasts').send({ modelId: 'm1', forecastType: 'bogus' })).status).toBe(400);
    expect((await request(app()).post('/digital-twin/forecasts').send({ modelId: 'm1', forecastType: 'revenue', horizonDays: 9999 })).status).toBe(400);
    expect((await request(app()).post('/digital-twin/forecasts').send({ modelId: 'm1', forecastType: 'revenue', confidenceLevel: 0.1 })).status).toBe(400);
  });
  it('generates a forecast', async () => {
    a.forecast.generateForecast.mockResolvedValue({ id: 'f1' });
    const res = await request(app()).post('/digital-twin/forecasts').send({ modelId: 'm1', forecastType: 'revenue' });
    expect(res.status).toBe(201);
  });
  it('lists + gets forecasts (404)', async () => {
    a.forecast.getForecasts.mockResolvedValue([{ id: 'f1' }]);
    expect((await request(app()).get('/digital-twin/forecasts')).body.forecasts).toHaveLength(1);
    a.forecast.getForecast.mockResolvedValueOnce(null);
    expect((await request(app()).get('/digital-twin/forecasts/x')).status).toBe(404);
  });
});

describe('digital-twin validate', () => {
  it('validates input + runs validation', async () => {
    expect((await request(app()).post('/digital-twin/validate').send({ modelId: 'm1' })).status).toBe(400);
    a.autopilot.validateWithDigitalTwin.mockResolvedValue({ verdict: 'ok' });
    const res = await request(app()).post('/digital-twin/validate').send({ recommendationId: 'rec1', modelId: 'm1', scenarioId: 's1' });
    expect(res.body.validation).toMatchObject({ verdict: 'ok' });
  });
});
