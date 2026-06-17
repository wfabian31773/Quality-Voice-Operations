import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const names = [
  'runAutopilotScan', 'getAutopilotInsights', 'getAutopilotRecommendations', 'getAutopilotRuns',
  'getAutopilotDashboardSummary', 'approveRecommendation', 'rejectRecommendation', 'dismissRecommendation',
  'executeAction', 'rollbackAction', 'getActionHistory', 'getPolicies', 'upsertPolicy', 'getImpactReports',
  'getNotifications', 'markNotificationRead', 'markAllNotificationsRead', 'getAvailableIndustryPacks',
] as const;

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  mocks: Object.fromEntries(['runAutopilotScan', 'getAutopilotInsights', 'getAutopilotRecommendations', 'getAutopilotRuns', 'getAutopilotDashboardSummary', 'approveRecommendation', 'rejectRecommendation', 'dismissRecommendation', 'executeAction', 'rollbackAction', 'getActionHistory', 'getPolicies', 'upsertPolicy', 'getImpactReports', 'getNotifications', 'markNotificationRead', 'markAllNotificationsRead', 'getAvailableIndustryPacks'].map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/autopilot', () => a.mocks);

import router from './autopilot';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  for (const n of names) a.mocks[n].mockReset().mockResolvedValue({ ok: n });
  a.mocks.getAvailableIndustryPacks.mockReturnValue([{ id: 'dental' }]);
});

describe('autopilot read routes', () => {
  it('GET /autopilot/summary', async () => {
    a.mocks.getAutopilotDashboardSummary.mockResolvedValue({ pending: 2 });
    expect((await request(app()).get('/autopilot/summary')).body).toEqual({ pending: 2 });
  });
  it('GET /autopilot/insights clamps limit/offset', async () => {
    await request(app()).get('/autopilot/insights?limit=9999&offset=-5&status=open');
    expect(a.mocks.getAutopilotInsights).toHaveBeenCalledWith('t1', expect.objectContaining({ limit: 100, offset: 0, status: 'open' }));
  });
  it('GET /autopilot/recommendations', async () => {
    expect((await request(app()).get('/autopilot/recommendations')).status).toBe(200);
  });
  it('GET /autopilot/actions', async () => {
    expect((await request(app()).get('/autopilot/actions')).status).toBe(200);
  });
  it('GET /autopilot/policies', async () => {
    a.mocks.getPolicies.mockResolvedValue([{ id: 'p1' }]);
    expect((await request(app()).get('/autopilot/policies')).body.policies).toHaveLength(1);
  });
  it('GET /autopilot/impact-reports', async () => {
    expect((await request(app()).get('/autopilot/impact-reports')).status).toBe(200);
  });
  it('GET /autopilot/runs', async () => {
    a.mocks.getAutopilotRuns.mockResolvedValue([{ id: 'r1' }]);
    expect((await request(app()).get('/autopilot/runs')).body.runs).toHaveLength(1);
  });
  it('GET /autopilot/notifications', async () => {
    expect((await request(app()).get('/autopilot/notifications?unreadOnly=true')).status).toBe(200);
  });
  it('GET /autopilot/industry-packs', async () => {
    expect((await request(app()).get('/autopilot/industry-packs')).body.packs).toHaveLength(1);
  });
  it('returns 500 when a source throws', async () => {
    a.mocks.getAutopilotDashboardSummary.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/autopilot/summary')).status).toBe(500);
  });
});

describe('recommendation lifecycle', () => {
  it('approves a recommendation', async () => {
    a.mocks.approveRecommendation.mockResolvedValue({ id: 'r1', status: 'approved' });
    expect((await request(app()).post('/autopilot/recommendations/r1/approve')).body.recommendation).toMatchObject({ status: 'approved' });
  });
  it('returns 404 when approve finds nothing pending', async () => {
    a.mocks.approveRecommendation.mockResolvedValue(null);
    expect((await request(app()).post('/autopilot/recommendations/x/approve')).status).toBe(404);
  });
  it('maps an Insufficient role error to 403 on approve', async () => {
    a.mocks.approveRecommendation.mockRejectedValue(new Error('Insufficient role for this action'));
    expect((await request(app()).post('/autopilot/recommendations/r1/approve')).status).toBe(403);
  });
  it('rejects a recommendation', async () => {
    a.mocks.rejectRecommendation.mockResolvedValue({ id: 'r1', status: 'rejected' });
    expect((await request(app()).post('/autopilot/recommendations/r1/reject').send({ reason: 'no' })).status).toBe(200);
  });
  it('dismisses a recommendation (404 path)', async () => {
    a.mocks.dismissRecommendation.mockResolvedValue(null);
    expect((await request(app()).post('/autopilot/recommendations/x/dismiss')).status).toBe(404);
  });
  it('maps a "must be approved" execute error to 400', async () => {
    a.mocks.executeAction.mockRejectedValue(new Error('Action must be approved before execution'));
    expect((await request(app()).post('/autopilot/recommendations/r1/execute')).status).toBe(400);
  });
  it('executes an approved recommendation', async () => {
    a.mocks.executeAction.mockResolvedValue({ id: 'act1' });
    expect((await request(app()).post('/autopilot/recommendations/r1/execute')).body.action).toMatchObject({ id: 'act1' });
  });
});

describe('actions & policies', () => {
  it('rolls back an action (manager-gated)', async () => {
    a.mocks.rollbackAction.mockResolvedValue({ id: 'act1', rolledBack: true });
    expect((await request(app()).post('/autopilot/actions/act1/rollback')).status).toBe(200);
  });
  it('blocks a viewer from rollback', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/autopilot/actions/act1/rollback')).status).toBe(403);
  });
  it('rejects a policy missing required fields', async () => {
    expect((await request(app()).post('/autopilot/policies').send({ name: 'P' })).status).toBe(400);
  });
  it('rejects an invalid riskTier', async () => {
    const res = await request(app()).post('/autopilot/policies').send({ name: 'P', riskTier: 'nuclear', actionType: 'x' });
    expect(res.status).toBe(400);
  });
  it('upserts a valid policy', async () => {
    a.mocks.upsertPolicy.mockResolvedValue({ id: 'p1' });
    const res = await request(app()).post('/autopilot/policies').send({ name: 'P', riskTier: 'low', actionType: 'tune' });
    expect(res.status).toBe(200);
    expect(res.body.policy).toMatchObject({ id: 'p1' });
  });
  it('runs a manual scan (manager-gated)', async () => {
    a.mocks.runAutopilotScan.mockResolvedValue({ scanned: 3 });
    const res = await request(app()).post('/autopilot/scan');
    expect(res.status).toBe(200);
    expect(a.mocks.runAutopilotScan).toHaveBeenCalledWith('t1', 'manual');
  });
});

describe('notifications', () => {
  it('marks one read', async () => {
    a.mocks.markNotificationRead.mockResolvedValue(true);
    expect((await request(app()).post('/autopilot/notifications/n1/read')).body).toEqual({ success: true });
  });
  it('marks all read', async () => {
    a.mocks.markAllNotificationsRead.mockResolvedValue(7);
    expect((await request(app()).post('/autopilot/notifications/read-all')).body).toEqual({ count: 7 });
  });
});
