import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  recordActivationEventMock: vi.fn(),
  checkTrialAgentLimitMock: vi.fn(),
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
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/agent-templates/toolPermissions', () => ({ getTemplatePermissions: vi.fn(), getAllKnownTools: vi.fn(() => []) }));
vi.mock('../../../platform/activation/ActivationService', () => ({ recordActivationEvent: a.recordActivationEventMock }));
vi.mock('../../../platform/billing/guardrails/TrialGuard', () => ({ checkTrialAgentLimit: a.checkTrialAgentLimitMock }));

import router from './agents';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
  a.writeAuditLogMock.mockReset();
  a.recordActivationEventMock.mockReset().mockResolvedValue(undefined);
  a.checkTrialAgentLimitMock.mockReset().mockResolvedValue({ allowed: true });
});

describe('GET /agents', () => {
  it('lists agents with a total', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY created_at DESC')) return { rows: [{ id: 'a1', name: 'Bot' }] };
      if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: '1' }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/agents');
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.agents).toHaveLength(1);
  });
  it('500 + rollback on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/agents')).status).toBe(500);
  });
});

describe('GET /agents/:id', () => {
  it('404 when missing', async () => {
    a.queryMock.mockImplementation(async (sql: string) => (sql.includes('WHERE id = $1 AND tenant_id = $2') ? { rows: [] } : { rows: [] }));
    expect((await request(app()).get('/agents/a1')).status).toBe(404);
  });
  it('returns the agent', async () => {
    a.queryMock.mockImplementation(async (sql: string) => (sql.includes('WHERE id = $1 AND tenant_id = $2') ? { rows: [{ id: 'a1' }] } : { rows: [] }));
    expect((await request(app()).get('/agents/a1')).body.agent).toMatchObject({ id: 'a1' });
  });
});

describe('POST /agents', () => {
  it('requires a name', async () => {
    expect((await request(app()).post('/agents').send({ type: 'general' })).status).toBe(400);
  });
  it('rejects an invalid type', async () => {
    expect((await request(app()).post('/agents').send({ name: 'Bot', type: 'spaceship' })).status).toBe(400);
  });
  it('rejects malformed tools', async () => {
    expect((await request(app()).post('/agents').send({ name: 'Bot', tools: ['nope'] })).status).toBe(400);
  });
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/agents').send({ name: 'Bot' })).status).toBe(403);
  });
  it('blocks creation when the trial agent limit is reached', async () => {
    a.checkTrialAgentLimitMock.mockResolvedValue({ allowed: false, reason: 'Trial allows 1 agent' });
    expect((await request(app()).post('/agents').send({ name: 'Bot' })).status).toBe(403);
  });
  it('creates an agent', async () => {
    a.queryMock.mockImplementation(async (sql: string) => (sql.includes('INSERT INTO agents') ? { rows: [{ id: 'a9', name: 'Bot' }] } : { rows: [] }));
    const res = await request(app()).post('/agents').send({ name: 'Bot', type: 'dental', language: 'en' });
    expect(res.status).toBe(201);
    expect(res.body.agent).toMatchObject({ id: 'a9' });
    expect(a.recordActivationEventMock).toHaveBeenCalled();
  });
});

describe('PATCH /agents/:id validation', () => {
  it('rejects an invalid type', async () => {
    expect((await request(app()).patch('/agents/a1').send({ type: 'spaceship' })).status).toBe(400);
  });
  it('rejects an empty update', async () => {
    expect((await request(app()).patch('/agents/a1').send({})).status).toBe(400);
  });
});

describe('DELETE /agents/:id', () => {
  it('refuses to delete a federated agent (403)', async () => {
    a.queryMock.mockImplementation(async (sql: string) => (sql.includes('SELECT execution_mode FROM agents') ? { rows: [{ execution_mode: 'federated' }] } : { rows: [] }));
    expect((await request(app()).delete('/agents/a1')).status).toBe(403);
  });
  it('deletes an agent', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT execution_mode FROM agents')) return { rows: [{ execution_mode: 'local' }] };
      if (sql.includes('DELETE FROM agents')) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });
    expect((await request(app()).delete('/agents/a1')).body).toEqual({ deleted: true });
  });
  it('404 when nothing deleted', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT execution_mode FROM agents')) return { rows: [] };
      if (sql.includes('DELETE FROM agents')) return { rows: [], rowCount: 0 };
      return { rows: [] };
    });
    expect((await request(app()).delete('/agents/ghost')).status).toBe(404);
  });
});
