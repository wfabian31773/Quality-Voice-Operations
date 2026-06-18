import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => {
  const mk = (ns: string[]) => Object.fromEntries(ns.map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
  return {
    user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: true },
    signal: mk(['runSignalCollection', 'getSignals']),
    opp: mk(['runOpportunityDetection', 'getOpportunities', 'getOpportunityById']),
    rec: mk(['generateRoadmapRecommendations', 'getRecommendations', 'getRecommendationById', 'updateRecommendationStatus']),
    exp: mk(['createExperiment', 'getExperiments', 'getExperimentById', 'updateExperimentState', 'updateExperiment']),
    sched: mk(['startEvolutionScheduler', 'stopEvolutionScheduler', 'isSchedulerRunning', 'isPipelineRunning']),
    queryMock: vi.fn(),
  };
});

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/evolution/SignalCollector', () => a.signal);
vi.mock('../../../platform/evolution/OpportunityDetectionEngine', () => a.opp);
vi.mock('../../../platform/evolution/RoadmapRecommendationEngine', () => a.rec);
vi.mock('../../../platform/evolution/ExperimentManager', () => a.exp);
vi.mock('../../../platform/evolution/EvolutionScheduler', () => a.sched);
vi.mock('../../../platform/db', () => ({
  withPrivilegedClient: async (cb: (c: unknown) => Promise<unknown>) => cb({ query: a.queryMock }),
}));

import router from './evolution';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  for (const grp of [a.signal, a.opp, a.rec, a.exp, a.sched]) {
    for (const fn of Object.values(grp)) fn.mockReset().mockResolvedValue({ ok: true });
  }
  a.signal.runSignalCollection.mockResolvedValue(3);
  a.opp.runOpportunityDetection.mockResolvedValue(2);
  a.rec.generateRoadmapRecommendations.mockResolvedValue(1);
  a.sched.isSchedulerRunning.mockReturnValue(true);
  a.sched.isPipelineRunning.mockReturnValue(false);
  a.sched.startEvolutionScheduler.mockReturnValue(undefined);
  a.sched.stopEvolutionScheduler.mockReturnValue(undefined);
  a.queryMock.mockReset().mockResolvedValue({ rows: [{}] });
});

describe('platform-admin gate', () => {
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/evolution/signals')).status).toBe(403);
  });
});

describe('signals & opportunities', () => {
  it('GET /evolution/signals', async () => {
    a.signal.getSignals.mockResolvedValue({ signals: [], total: 0 });
    expect((await request(app()).get('/evolution/signals?source=x&limit=10')).status).toBe(200);
  });
  it('POST /evolution/signals/collect', async () => {
    expect((await request(app()).post('/evolution/signals/collect')).body).toEqual({ success: true, signalsCollected: 3 });
  });
  it('GET /evolution/opportunities', async () => {
    a.opp.getOpportunities.mockResolvedValue({ opportunities: [] });
    expect((await request(app()).get('/evolution/opportunities?min_score=5')).status).toBe(200);
  });
  it('GET /evolution/opportunities/:id (found/404)', async () => {
    a.opp.getOpportunityById.mockResolvedValueOnce({ id: 'o1' });
    expect((await request(app()).get('/evolution/opportunities/o1')).body.opportunity).toMatchObject({ id: 'o1' });
    a.opp.getOpportunityById.mockResolvedValueOnce(null);
    expect((await request(app()).get('/evolution/opportunities/x')).status).toBe(404);
  });
  it('POST /evolution/opportunities/detect', async () => {
    expect((await request(app()).post('/evolution/opportunities/detect')).body.opportunitiesDetected).toBe(2);
  });
});

describe('recommendations', () => {
  it('GET list + :id 404', async () => {
    a.rec.getRecommendations.mockResolvedValue({ recommendations: [] });
    expect((await request(app()).get('/evolution/recommendations')).status).toBe(200);
    a.rec.getRecommendationById.mockResolvedValueOnce(null);
    expect((await request(app()).get('/evolution/recommendations/x')).status).toBe(404);
  });
  it('POST /generate', async () => {
    expect((await request(app()).post('/evolution/recommendations/generate')).body.recommendationsGenerated).toBe(1);
  });
  it('PATCH /:id/status (missing/invalid/404/success)', async () => {
    expect((await request(app()).patch('/evolution/recommendations/r1/status').send({})).status).toBe(400);
    a.rec.updateRecommendationStatus.mockRejectedValueOnce(new Error('Invalid status: foo'));
    expect((await request(app()).patch('/evolution/recommendations/r1/status').send({ status: 'foo' })).status).toBe(400);
    a.rec.updateRecommendationStatus.mockResolvedValueOnce(null);
    expect((await request(app()).patch('/evolution/recommendations/x/status').send({ status: 'approved' })).status).toBe(404);
    a.rec.updateRecommendationStatus.mockResolvedValueOnce({ id: 'r1', status: 'approved' });
    expect((await request(app()).patch('/evolution/recommendations/r1/status').send({ status: 'approved' })).status).toBe(200);
  });
});

describe('experiments', () => {
  it('GET list + :id 404', async () => {
    a.exp.getExperiments.mockResolvedValue({ experiments: [] });
    expect((await request(app()).get('/evolution/experiments')).status).toBe(200);
    a.exp.getExperimentById.mockResolvedValueOnce(null);
    expect((await request(app()).get('/evolution/experiments/x')).status).toBe(404);
  });
  it('POST create (validation + success)', async () => {
    expect((await request(app()).post('/evolution/experiments').send({ experimentName: 'E' })).status).toBe(400);
    a.exp.createExperiment.mockResolvedValue({ id: 'e1' });
    expect((await request(app()).post('/evolution/experiments').send({ experimentName: 'E', experimentType: 'ab' })).status).toBe(201);
  });
  it('PATCH /:id (404/success)', async () => {
    a.exp.updateExperiment.mockResolvedValueOnce(null);
    expect((await request(app()).patch('/evolution/experiments/x').send({ hypothesis: 'h' })).status).toBe(404);
    a.exp.updateExperiment.mockResolvedValueOnce({ id: 'e1' });
    expect((await request(app()).patch('/evolution/experiments/e1').send({ hypothesis: 'h' })).status).toBe(200);
  });
  it('PATCH /:id/state (missing/invalid/404/success)', async () => {
    expect((await request(app()).patch('/evolution/experiments/e1/state').send({})).status).toBe(400);
    a.exp.updateExperimentState.mockRejectedValueOnce(new Error('Invalid experiment state: zzz'));
    expect((await request(app()).patch('/evolution/experiments/e1/state').send({ state: 'zzz' })).status).toBe(400);
    a.exp.updateExperimentState.mockResolvedValueOnce(null);
    expect((await request(app()).patch('/evolution/experiments/x/state').send({ state: 'active' })).status).toBe(404);
    a.exp.updateExperimentState.mockResolvedValueOnce({ id: 'e1', state: 'active' });
    expect((await request(app()).patch('/evolution/experiments/e1/state').send({ state: 'active' })).status).toBe(200);
  });
});

describe('dashboard, pipeline & scheduler', () => {
  it('GET /evolution/dashboard aggregates stats', async () => {
    const res = await request(app()).get('/evolution/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.dashboard).toHaveProperty('opportunities');
    expect(res.body.dashboard).toHaveProperty('recommendations');
    expect(res.body.dashboard).toHaveProperty('experiments');
  });
  it('returns 500 when the dashboard query fails', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/evolution/dashboard')).status).toBe(500);
  });
  it('POST /evolution/run-pipeline', async () => {
    const res = await request(app()).post('/evolution/run-pipeline');
    expect(res.body).toMatchObject({ success: true, signalsCollected: 3, opportunitiesDetected: 2, recommendationsGenerated: 1 });
  });
  it('GET /evolution/scheduler/status', async () => {
    expect((await request(app()).get('/evolution/scheduler/status')).body).toEqual({ schedulerRunning: true, pipelineRunning: false });
  });
  it('POST /evolution/scheduler/start', async () => {
    const res = await request(app()).post('/evolution/scheduler/start').send({ intervalHours: 12 });
    expect(res.body).toEqual({ success: true, intervalHours: 12 });
    expect(a.sched.startEvolutionScheduler).toHaveBeenCalled();
  });
  it('POST /evolution/scheduler/stop', async () => {
    expect((await request(app()).post('/evolution/scheduler/stop')).body).toEqual({ success: true });
    expect(a.sched.stopEvolutionScheduler).toHaveBeenCalled();
  });
});
