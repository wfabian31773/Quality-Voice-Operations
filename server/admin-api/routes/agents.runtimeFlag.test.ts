/**
 * RT-14 prereq: only platform staff may set, change or remove
 * agents.metadata.runtime (the RT-09 composer switch) on any agents.ts path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  stored: {} as Record<string, unknown>,
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: vi.fn() }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: vi.fn(), extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/agent-templates/toolPermissions', () => ({ getTemplatePermissions: vi.fn(() => ({ deniedTools: [] })), getAllKnownTools: vi.fn(() => []) }));
vi.mock('../../../platform/activation/ActivationService', () => ({ recordActivationEvent: vi.fn(async () => {}) }));
vi.mock('../../../platform/billing/guardrails/TrialGuard', () => ({ checkTrialAgentLimit: vi.fn(async () => ({ allowed: true })) }));

import router from './agents';
import { RUNTIME_FLAG_FORBIDDEN } from '../services/agentRuntimeFlag';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

/** A fake agents table with one agent whose metadata is a.stored. */
function fakeDb() {
  a.queryMock.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT execution_mode FROM agents')) return { rows: [{ execution_mode: 'local' }] };
    if (sql.includes('SELECT metadata FROM agents')) return { rows: [{ metadata: a.stored }] };
    if (sql.includes('SELECT * FROM agents')) return { rows: [{ id: 'a1', name: 'Front desk', type: 'barbershop', metadata: a.stored, tools: [] }] };
    if (sql.includes('MAX(version)')) return { rows: [{ max_version: 0 }] };
    if (sql.includes('SELECT * FROM agent_versions')) {
      return { rows: [{ version: 1, workflow_definition: { settings: { language: 'es', tone: 'calm' } }, system_prompt: 'p', tools: [] }] };
    }
    if (sql.includes('INSERT INTO agents')) return { rows: [{ id: 'a9', metadata: JSON.parse(String(values[10])) }] };
    if (sql.includes('UPDATE agents')) return { rows: [{ id: 'a1' }] };
    return { rows: [] };
  });
}

const sqlCalls = () => a.queryMock.mock.calls as Array<[string, unknown[]?]>;
const agentWrites = () => sqlCalls().filter(([sql]) => /UPDATE agents|INSERT INTO agents/.test(sql));

/** The metadata JSON an `UPDATE agents ... metadata = $n` wrote. */
function writtenMetadata(): Record<string, unknown> {
  const [sql, values = []] = agentWrites().at(-1)!;
  const match = /metadata = \$(\d+)/.exec(sql);
  expect(match).not.toBeNull();
  return JSON.parse(String(values[Number(match![1]) - 1])) as Record<string, unknown>;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.isPlatformAdmin = false;
  a.stored = { runtime: 'composer', businessName: 'Sharp Line Barbers' };
  a.queryMock.mockReset();
  fakeDb();
});

describe('PATCH /agents/:id metadata.runtime', () => {
  it('a manager who sets or changes runtime gets 403 and nothing is written', async () => {
    a.stored = { businessName: 'Sharp Line Barbers' };
    const set = await request(app()).patch('/agents/a1').send({ metadata: { businessName: 'Sharp Line Barbers', runtime: 'composer' } });
    expect(set.status).toBe(403);
    expect(set.body.error).toBe(RUNTIME_FLAG_FORBIDDEN);
    expect(agentWrites()).toEqual([]);
    expect(sqlCalls().map(([sql]) => sql)).toContain('ROLLBACK');
  });

  it('a manager who removes runtime gets 403 and the stored value stays', async () => {
    const off = await request(app()).patch('/agents/a1').send({ metadata: { businessName: 'Sharp Line Barbers', runtime: null } });
    expect(off.status).toBe(403);
    expect(agentWrites()).toEqual([]);
  });

  it('a manager PATCH of other metadata keeps the stored runtime', async () => {
    const res = await request(app()).patch('/agents/a1').send({ metadata: { businessName: 'New Name' } });
    expect(res.status).toBe(200);
    expect(writtenMetadata()).toEqual({ businessName: 'New Name', runtime: 'composer' });
  });

  it('a manager PATCH without metadata never reads or writes it', async () => {
    const res = await request(app()).patch('/agents/a1').send({ name: 'Desk' });
    expect(res.status).toBe(200);
    expect(sqlCalls().some(([sql]) => sql.includes('SELECT metadata FROM agents'))).toBe(false);
    expect(agentWrites()[0][0]).not.toMatch(/metadata/);
  });

  it('a platform admin can set it and clear it', async () => {
    a.user.isPlatformAdmin = true;
    a.stored = { businessName: 'Sharp Line Barbers' };
    expect((await request(app()).patch('/agents/a1').send({ metadata: { businessName: 'Sharp Line Barbers', runtime: 'composer' } })).status).toBe(200);
    expect(writtenMetadata()).toEqual({ businessName: 'Sharp Line Barbers', runtime: 'composer' });

    a.stored = { businessName: 'Sharp Line Barbers', runtime: 'composer' };
    expect((await request(app()).patch('/agents/a1').send({ metadata: { businessName: 'Sharp Line Barbers', runtime: null } })).status).toBe(200);
    expect(writtenMetadata()).toEqual({ businessName: 'Sharp Line Barbers' });
  });
});

describe('POST /agents metadata.runtime', () => {
  it('a tenant user creating an agent with runtime gets 403 and nothing is inserted', async () => {
    const res = await request(app()).post('/agents').send({ name: 'Bot', metadata: { runtime: 'composer' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(RUNTIME_FLAG_FORBIDDEN);
    expect(agentWrites()).toEqual([]);
  });

  it('a platform admin can create one with runtime; a tenant user can create one without', async () => {
    a.user.isPlatformAdmin = true;
    expect((await request(app()).post('/agents').send({ name: 'Bot', metadata: { runtime: 'composer' } })).body.agent.metadata).toEqual({ runtime: 'composer' });
    a.user.isPlatformAdmin = false;
    expect((await request(app()).post('/agents').send({ name: 'Bot', metadata: { businessName: 'X' } })).status).toBe(201);
  });
});

describe('publish and version rollback never change metadata.runtime', () => {
  it('publish keeps it', async () => {
    const res = await request(app()).post('/agents/a1/publish').send({});
    expect(res.status).toBe(200);
    expect(writtenMetadata()).toMatchObject({ runtime: 'composer', businessName: 'Sharp Line Barbers' });
  });

  it('rollback keeps it, and does not add one that was not stored', async () => {
    const res = await request(app()).post('/agents/a1/rollback').send({ version: 1 });
    expect(res.status).toBe(200);
    expect(writtenMetadata()).toMatchObject({ language: 'es', tone: 'calm', runtime: 'composer' });

    a.stored = {};
    await request(app()).post('/agents/a1/rollback').send({ version: 1 });
    expect(writtenMetadata()).not.toHaveProperty('runtime');
  });
});

describe('Codex 4307682356: publish locks the agent row before keeping the stored runtime', () => {
  /**
   * A platform admin's runtime change lands while publish runs: an unlocked read
   * still sees the old row, a FOR UPDATE read waits for it and sees the new one.
   */
  function racingDb() {
    const before = { runtime: 'composer', businessName: 'Sharp Line Barbers' };
    const after = { runtime: 'legacy', businessName: 'Sharp Line Barbers' };
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM agents')) {
        const metadata = /FOR UPDATE/.test(sql) ? after : before;
        return { rows: [{ id: 'a1', name: 'Front desk', type: 'barbershop', metadata, tools: [] }] };
      }
      if (sql.includes('MAX(version)')) return { rows: [{ max_version: 0 }] };
      if (sql.includes('UPDATE agents')) return { rows: [{ id: 'a1' }] };
      return { rows: [] };
    });
  }

  const order = () => sqlCalls().map(([sql]) => sql).filter((sql) =>
    /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /FROM agents|UPDATE agents/.test(sql));

  it('the runtime written is the one the locked read returned (a concurrent change survives)', async () => {
    racingDb();
    const res = await request(app()).post('/agents/a1/publish').send({});
    expect(res.status).toBe(200);
    expect(writtenMetadata()).toMatchObject({ runtime: 'legacy', businessName: 'Sharp Line Barbers' });
  });

  it('BEGIN → SELECT … FOR UPDATE → UPDATE agents → COMMIT', async () => {
    racingDb();
    await request(app()).post('/agents/a1/publish').send({});
    const seq = order();
    expect(seq).toHaveLength(4);
    expect(seq[0]).toBe('BEGIN');
    expect(seq[1]).toMatch(/SELECT \* FROM agents .*FOR UPDATE/);
    expect(seq[2]).toMatch(/^UPDATE agents/);
    expect(seq[3]).toBe('COMMIT');
  });

  it('a failed write rolls back and never commits', async () => {
    racingDb();
    const base = a.queryMock.getMockImplementation()!;
    a.queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('UPDATE agents')) throw new Error('db down');
      return base(sql, values);
    });
    const res = await request(app()).post('/agents/a1/publish').send({});
    expect(res.status).toBe(500);
    const seq = order();
    expect(seq[0]).toBe('BEGIN');
    expect(seq[1]).toMatch(/FOR UPDATE/);
    expect(seq.at(-1)).toBe('ROLLBACK');
    expect(seq).not.toContain('COMMIT');
  });
});
