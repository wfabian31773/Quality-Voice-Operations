import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));

import workflowsRouter from './workflows';

function app() {
  const app = express();
  app.use(express.json());
  app.use(workflowsRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
});

describe('role gate', () => {
  it('rejects roles outside owner/manager with 403', async () => {
    a.user.role = 'agent_developer';
    expect((await request(app()).get('/workflows')).status).toBe(403);
  });
});

describe('GET /workflows', () => {
  it('lists workflows with a total', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '3' }] };
      if (sql.includes('FROM workflows')) return { rows: [{ id: 'w1', name: 'Onboard' }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/workflows?limit=10&page=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, limit: 10, offset: 0 });
    expect(res.body.workflows).toHaveLength(1);
  });

  it('returns 500 and rolls back on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/workflows')).status).toBe(500);
    expect(a.queryMock.mock.calls.some(([sql]) => /ROLLBACK/i.test(String(sql)))).toBe(true);
  });
});

describe('GET /workflows/:id', () => {
  it('returns a workflow when found', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT * FROM workflows') ? { rows: [{ id: 'w1' }] } : { rows: [] },
    );
    const res = await request(app()).get('/workflows/w1');
    expect(res.body.workflow).toEqual({ id: 'w1' });
  });

  it('returns 404 when not found', async () => {
    expect((await request(app()).get('/workflows/missing')).status).toBe(404);
  });
});

describe('POST /workflows', () => {
  it('requires a name', async () => {
    expect((await request(app()).post('/workflows').send({ description: 'x' })).status).toBe(400);
  });

  it('rejects non-array steps', async () => {
    const res = await request(app()).post('/workflows').send({ name: 'W', steps: 'nope' });
    expect(res.status).toBe(400);
  });

  it('creates a workflow', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO workflows') ? { rows: [{ id: 'w9', name: 'W' }] } : { rows: [] },
    );
    const res = await request(app()).post('/workflows').send({ name: 'W', steps: [{ type: 'say' }] });
    expect(res.status).toBe(201);
    expect(res.body.workflow).toMatchObject({ id: 'w9' });
  });
});

describe('PATCH /workflows/:id', () => {
  it('rejects non-array steps', async () => {
    expect((await request(app()).patch('/workflows/w1').send({ steps: 'no' })).status).toBe(400);
  });

  it('rejects an empty update', async () => {
    expect((await request(app()).patch('/workflows/w1').send({})).status).toBe(400);
  });

  it('updates allowed fields', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE workflows SET') ? { rows: [{ id: 'w1', name: 'New' }] } : { rows: [] },
    );
    const res = await request(app()).patch('/workflows/w1').send({ name: 'New', steps: [] });
    expect(res.status).toBe(200);
    expect(res.body.workflow).toMatchObject({ name: 'New' });
  });

  it('returns 404 when the workflow is missing', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE workflows SET') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).patch('/workflows/missing').send({ name: 'x' })).status).toBe(404);
  });
});

describe('DELETE /workflows/:id', () => {
  it('deletes a workflow and detaches it from agents', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('DELETE FROM workflows') ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
    const res = await request(app()).delete('/workflows/w1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE agents SET workflow_id = NULL'))).toBe(true);
  });

  it('returns 404 when nothing was deleted', async () => {
    expect((await request(app()).delete('/workflows/missing')).status).toBe(404);
  });
});
