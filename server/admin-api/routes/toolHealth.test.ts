import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  getToolHealthMetricsMock: vi.fn(),
  listEscalationTasksMock: vi.fn(),
  updateEscalationTaskMock: vi.fn(),
  getEscalationTaskStatsMock: vi.fn(),
  listEscalationRecipientsMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/tools/ToolHealthService', () => ({ getToolHealthMetrics: a.getToolHealthMetricsMock }));
vi.mock('../../../platform/tools/HumanEscalationService', () => ({
  listEscalationTasks: a.listEscalationTasksMock,
  updateEscalationTask: a.updateEscalationTaskMock,
  getEscalationTaskStats: a.getEscalationTaskStatsMock,
  listEscalationRecipients: a.listEscalationRecipientsMock,
}));

import toolHealthRouter from './toolHealth';

function app() {
  const app = express();
  app.use(express.json());
  app.use(toolHealthRouter);
  return app;
}

beforeEach(() => {
  a.getToolHealthMetricsMock.mockReset().mockResolvedValue({ tools: [], overallSuccessRate: 100, totalExecutions: 0 });
  a.listEscalationTasksMock.mockReset().mockResolvedValue({ tasks: [], total: 0 });
  a.updateEscalationTaskMock.mockReset();
  a.getEscalationTaskStatsMock.mockReset().mockResolvedValue({ open: 0, resolved: 0 });
  a.listEscalationRecipientsMock.mockReset().mockResolvedValue([]);
});

describe('GET /tool-health/metrics', () => {
  it('merges health metrics with escalation stats and maps the window', async () => {
    a.getToolHealthMetricsMock.mockResolvedValue({ tools: [{ toolName: 'x' }], overallSuccessRate: 99, totalExecutions: 5 });
    a.getEscalationTaskStatsMock.mockResolvedValue({ open: 2 });
    const res = await request(app()).get('/tool-health/metrics?window=30d');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ window: '30d', overallSuccessRate: 99, escalationStats: { open: 2 } });
    expect(a.getToolHealthMetricsMock).toHaveBeenCalledWith('t1', 30);
  });

  it('defaults to a 7-day window for unknown values', async () => {
    await request(app()).get('/tool-health/metrics?window=bogus');
    expect(a.getToolHealthMetricsMock).toHaveBeenCalledWith('t1', 7);
  });

  it('returns 500 when the metrics fetch fails', async () => {
    a.getToolHealthMetricsMock.mockRejectedValue(new Error('boom'));
    const res = await request(app()).get('/tool-health/metrics');
    expect(res.status).toBe(500);
  });
});

describe('GET /escalation-tasks', () => {
  it('returns a paged task list with computed totalPages', async () => {
    a.listEscalationTasksMock.mockResolvedValue({ tasks: [{ id: 't' }], total: 25 });
    const res = await request(app()).get('/escalation-tasks?limit=10&page=2');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 25, limit: 10, page: 2, totalPages: 3 });
    expect(a.listEscalationTasksMock).toHaveBeenCalledWith('t1', expect.objectContaining({ limit: 10, offset: 10 }));
  });

  it('caps the limit at 200', async () => {
    await request(app()).get('/escalation-tasks?limit=5000');
    expect(a.listEscalationTasksMock).toHaveBeenCalledWith('t1', expect.objectContaining({ limit: 200 }));
  });

  it('returns 500 on failure', async () => {
    a.listEscalationTasksMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/escalation-tasks')).status).toBe(500);
  });
});

describe('GET /escalation-tasks/recipients & /stats', () => {
  it('lists recipients', async () => {
    a.listEscalationRecipientsMock.mockResolvedValue([{ id: 'r1' }]);
    const res = await request(app()).get('/escalation-tasks/recipients');
    expect(res.body.recipients).toHaveLength(1);
  });

  it('returns stats', async () => {
    a.getEscalationTaskStatsMock.mockResolvedValue({ open: 3, resolved: 7 });
    const res = await request(app()).get('/escalation-tasks/stats');
    expect(res.body).toEqual({ open: 3, resolved: 7 });
  });

  it('returns 500 when recipients lookup fails', async () => {
    a.listEscalationRecipientsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/escalation-tasks/recipients')).status).toBe(500);
  });
});

describe('PATCH /escalation-tasks/:id', () => {
  it('updates and returns the task', async () => {
    a.updateEscalationTaskMock.mockResolvedValue({ id: 'task-1', status: 'resolved' });
    const res = await request(app()).patch('/escalation-tasks/task-1').send({ status: 'resolved', notes: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({ id: 'task-1', status: 'resolved' });
  });

  it('returns 404 when the task does not exist', async () => {
    a.updateEscalationTaskMock.mockResolvedValue(null);
    const res = await request(app()).patch('/escalation-tasks/missing').send({ status: 'resolved' });
    expect(res.status).toBe(404);
  });

  it('returns 500 on update failure', async () => {
    a.updateEscalationTaskMock.mockRejectedValue(new Error('boom'));
    const res = await request(app()).patch('/escalation-tasks/task-1').send({ status: 'resolved' });
    expect(res.status).toBe(500);
  });
});
