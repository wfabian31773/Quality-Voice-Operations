import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  getCallQualityScoreMock: vi.fn(),
  getQualityAnalyticsMock: vi.fn(),
  getLowestScoringCallsMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/analytics', () => ({
  getCallQualityScore: a.getCallQualityScoreMock,
  getQualityAnalytics: a.getQualityAnalyticsMock,
  getLowestScoringCalls: a.getLowestScoringCallsMock,
}));

import qualityRouter from './quality';

function app() {
  const app = express();
  app.use(express.json());
  app.use(qualityRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.getCallQualityScoreMock.mockReset();
  a.getQualityAnalyticsMock.mockReset().mockResolvedValue({ avg: 4.2 });
  a.getLowestScoringCallsMock.mockReset().mockResolvedValue([]);
});

describe('GET /calls/:id/quality', () => {
  it('returns the quality score', async () => {
    a.getCallQualityScoreMock.mockResolvedValue({ score: 0.9 });
    const res = await request(app()).get('/calls/call-1/quality');
    expect(res.status).toBe(200);
    expect(res.body.quality).toEqual({ score: 0.9 });
  });

  it('returns 404 when there is no score', async () => {
    a.getCallQualityScoreMock.mockResolvedValue(null);
    expect((await request(app()).get('/calls/call-1/quality')).status).toBe(404);
  });

  it('rejects a viewer via the real rbac gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/calls/call-1/quality')).status).toBe(403);
  });

  it('returns 500 on failure', async () => {
    a.getCallQualityScoreMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/calls/call-1/quality')).status).toBe(500);
  });
});

describe('GET /analytics/quality', () => {
  it('returns trends and the lowest-scoring calls', async () => {
    a.getQualityAnalyticsMock.mockResolvedValue({ avg: 4.5 });
    a.getLowestScoringCallsMock.mockResolvedValue([{ id: 'c1' }]);
    const res = await request(app()).get('/analytics/quality?days=14');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ trends: { avg: 4.5 }, lowestScoring: [{ id: 'c1' }] });
    expect(a.getQualityAnalyticsMock).toHaveBeenCalledWith('t1', 14);
  });

  it('rejects an out-of-range days param', async () => {
    expect((await request(app()).get('/analytics/quality?days=0')).status).toBe(400);
    expect((await request(app()).get('/analytics/quality?days=999')).status).toBe(400);
  });

  it('returns 500 on failure', async () => {
    a.getQualityAnalyticsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/analytics/quality')).status).toBe(500);
  });
});
