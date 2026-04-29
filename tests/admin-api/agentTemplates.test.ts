/**
 * Coverage for the custom agent-template endpoints (Task #822):
 *
 *   GET    /agents/templates/custom         — list owned + tenant-shared
 *   POST   /agents/templates/custom         — save current canvas as template
 *   PATCH  /agents/templates/custom/:id     — edit (owner OR tenant_owner / admin)
 *   DELETE /agents/templates/custom/:id     — delete (same authz)
 *
 * These tests mock the platform pool, the auth/rbac middleware, and the audit
 * service so we can exercise just the route behaviour in isolation. The RLS
 * policy that lives in migration 091 is asserted via the SET LOCAL call from
 * `withTenantContext` — every handler must wrap its work in that context so
 * RLS can scope the underlying `agent_templates` rows to the active tenant.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));
const writeAuditLogMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  extractIp: () => '127.0.0.1',
}));

// Mutable user reference so individual tests can flip role/userId/admin
// without rebuilding the express app each time.
const currentUser: {
  tenantId: string;
  userId: string;
  role: string;
  isPlatformAdmin: boolean;
  email?: string;
} = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  role: 'manager',
  isPlatformAdmin: false,
  email: 'manager@acme.test',
};

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = { ...currentUser };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  simpleToDatabaseRole: (r: string) => r,
  dbRoleToSimple: (r: string) => r,
}));

import agentRoutes from '../../server/admin-api/routes/agents';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(agentRoutes);
  return app;
}

interface Stub {
  match: (sql: string) => boolean;
  rows: Record<string, unknown>[];
  rowCount?: number;
}

function installQueryStubs(stubs: Stub[]): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/SET LOCAL/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    for (const s of stubs) {
      if (s.match(sql)) {
        return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

const validWorkflow = {
  nodes: [
    { id: '1', type: 'conversation', position: { x: 0, y: 0 }, data: { nodeType: 'greeting', label: 'Hi' } },
  ],
  edges: [],
};

describe('GET /agents/templates/custom', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    writeAuditLogMock.mockReset();
    Object.assign(currentUser, {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'manager',
      isPlatformAdmin: false,
    });
  });

  it('returns owned and tenant-shared templates with is_owner annotation', async () => {
    installQueryStubs([
      {
        match: (sql) => /FROM agent_templates/i.test(sql) && /WHERE/i.test(sql),
        rows: [
          {
            id: 'tpl-mine',
            tenant_id: 'tenant-1',
            created_by_user_id: 'user-1',
            name: 'Mine',
            description: null,
            workflow_definition: validWorkflow,
            welcome_greeting: null,
            system_prompt: null,
            language: 'en',
            is_shared: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            author_first_name: 'Avery',
            author_last_name: 'Operator',
            author_email: 'manager@acme.test',
          },
          {
            id: 'tpl-shared',
            tenant_id: 'tenant-1',
            created_by_user_id: 'other-user',
            name: 'Team blueprint',
            description: 'Shared with the team',
            workflow_definition: validWorkflow,
            welcome_greeting: 'Hi',
            system_prompt: 'You are helpful',
            language: 'en',
            is_shared: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            author_first_name: 'Sam',
            author_last_name: 'Teammate',
            author_email: 'sam@acme.test',
          },
        ],
      },
    ]);

    const app = buildApp();
    const res = await request(app).get('/agents/templates/custom');
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(2);
    expect(res.body.templates[0]).toMatchObject({
      id: 'tpl-mine',
      is_owner: true,
      author_display_name: 'Avery Operator',
      author_email: 'manager@acme.test',
    });
    expect(res.body.templates[1]).toMatchObject({
      id: 'tpl-shared',
      is_owner: false,
      author_display_name: 'Sam Teammate',
      author_email: 'sam@acme.test',
    });
  });

  it('joins users to surface author info and falls back to email when no name is set', async () => {
    installQueryStubs([
      {
        match: (sql) => /FROM agent_templates/i.test(sql) && /LEFT JOIN users/i.test(sql),
        rows: [
          {
            id: 'tpl-no-name',
            tenant_id: 'tenant-1',
            created_by_user_id: 'other-user',
            name: 'Anonymous author',
            description: null,
            workflow_definition: validWorkflow,
            welcome_greeting: null,
            system_prompt: null,
            language: 'en',
            is_shared: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            author_first_name: null,
            author_last_name: null,
            author_email: 'someone@acme.test',
          },
          {
            id: 'tpl-deleted-author',
            tenant_id: 'tenant-1',
            created_by_user_id: 'gone-user',
            name: 'Orphaned template',
            description: null,
            workflow_definition: validWorkflow,
            welcome_greeting: null,
            system_prompt: null,
            language: 'en',
            is_shared: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            author_first_name: null,
            author_last_name: null,
            author_email: null,
          },
        ],
      },
    ]);

    const app = buildApp();
    const res = await request(app).get('/agents/templates/custom');

    expect(res.status).toBe(200);
    // We rely on a LEFT JOIN so templates whose author was deleted still come back.
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /LEFT JOIN users/i.test(s))).toBe(true);

    expect(res.body.templates[0]).toMatchObject({
      id: 'tpl-no-name',
      author_display_name: 'someone@acme.test',
      author_email: 'someone@acme.test',
    });
    expect(res.body.templates[1]).toMatchObject({
      id: 'tpl-deleted-author',
      author_display_name: null,
      author_email: null,
    });
  });

  it('binds tenant context inside a transaction so RLS scopes the rows', async () => {
    installQueryStubs([
      {
        match: (sql) => /FROM agent_templates/i.test(sql),
        rows: [],
      },
    ]);

    const app = buildApp();
    await request(app).get('/agents/templates/custom');

    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /^BEGIN/i.test(s))).toBe(true);
    expect(sqls.some((s) => /^COMMIT/i.test(s))).toBe(true);
  });
});

describe('POST /agents/templates/custom', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    writeAuditLogMock.mockReset();
    Object.assign(currentUser, {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'manager',
      isPlatformAdmin: false,
    });
  });

  it('rejects payloads with no name', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/agents/templates/custom')
      .send({ workflow_definition: validWorkflow });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it('rejects payloads with an invalid workflow_definition', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/agents/templates/custom')
      .send({ name: 'X', workflow_definition: { nodes: 'not-an-array', edges: [] } });
    expect(res.status).toBe(400);
  });

  it('rejects payloads with an unsupported language', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/agents/templates/custom')
      .send({ name: 'X', workflow_definition: validWorkflow, language: 'klingon' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/language must be one of/i);
  });

  it('inserts a row, returns is_owner=true, and writes an audit log', async () => {
    const inserted = {
      id: 'tpl-new',
      tenant_id: 'tenant-1',
      created_by_user_id: 'user-1',
      name: 'My template',
      description: null,
      workflow_definition: validWorkflow,
      welcome_greeting: 'Hi',
      system_prompt: 'You are helpful',
      language: 'en',
      is_shared: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    installQueryStubs([
      {
        match: (sql) => /INSERT INTO agent_templates/i.test(sql),
        rows: [inserted],
      },
    ]);

    const app = buildApp();
    const res = await request(app)
      .post('/agents/templates/custom')
      .send({
        name: '  My template  ',
        workflow_definition: validWorkflow,
        welcome_greeting: 'Hi',
        system_prompt: 'You are helpful',
        language: 'en',
        is_shared: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.template).toMatchObject({ id: 'tpl-new', is_owner: true });
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    expect(writeAuditLogMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      action: 'agent_template.created',
      resourceType: 'agent_template',
      resourceId: 'tpl-new',
    });
  });
});

describe('PATCH /agents/templates/custom/:id', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    writeAuditLogMock.mockReset();
    Object.assign(currentUser, {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'manager',
      isPlatformAdmin: false,
    });
  });

  it('returns 404 when the template does not exist for the tenant', async () => {
    installQueryStubs([
      {
        match: (sql) => /SELECT created_by_user_id FROM agent_templates/i.test(sql),
        rows: [],
      },
    ]);
    const app = buildApp();
    const res = await request(app)
      .patch('/agents/templates/custom/missing')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when a non-owner manager tries to edit someone else\'s template', async () => {
    installQueryStubs([
      {
        match: (sql) => /SELECT created_by_user_id FROM agent_templates/i.test(sql),
        rows: [{ created_by_user_id: 'other-user' }],
      },
    ]);
    const app = buildApp();
    const res = await request(app)
      .patch('/agents/templates/custom/tpl-1')
      .send({ name: 'New name' });
    expect(res.status).toBe(403);
  });

  it('lets the owner rename their own template', async () => {
    installQueryStubs([
      {
        match: (sql) => /SELECT created_by_user_id FROM agent_templates/i.test(sql),
        rows: [{ created_by_user_id: 'user-1' }],
      },
      {
        match: (sql) => /^UPDATE agent_templates/i.test(sql),
        rows: [
          {
            id: 'tpl-1',
            tenant_id: 'tenant-1',
            created_by_user_id: 'user-1',
            name: 'Renamed',
            description: null,
            workflow_definition: validWorkflow,
            welcome_greeting: null,
            system_prompt: null,
            language: 'en',
            is_shared: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
    ]);
    const app = buildApp();
    const res = await request(app)
      .patch('/agents/templates/custom/tpl-1')
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({ name: 'Renamed', is_owner: true });
    expect(writeAuditLogMock.mock.calls[0][0]).toMatchObject({
      action: 'agent_template.updated',
    });
  });

  it('lets a tenant_owner edit any template in the tenant', async () => {
    Object.assign(currentUser, { role: 'tenant_owner' });
    installQueryStubs([
      {
        match: (sql) => /SELECT created_by_user_id FROM agent_templates/i.test(sql),
        rows: [{ created_by_user_id: 'someone-else' }],
      },
      {
        match: (sql) => /^UPDATE agent_templates/i.test(sql),
        rows: [
          {
            id: 'tpl-1',
            tenant_id: 'tenant-1',
            created_by_user_id: 'someone-else',
            name: 'Renamed by owner',
            description: null,
            workflow_definition: validWorkflow,
            welcome_greeting: null,
            system_prompt: null,
            language: 'en',
            is_shared: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
    ]);
    const app = buildApp();
    const res = await request(app)
      .patch('/agents/templates/custom/tpl-1')
      .send({ name: 'Renamed by owner' });
    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({ is_owner: false });
  });

  it('returns 400 when no editable fields are supplied', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/agents/templates/custom/tpl-1')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /agents/templates/custom/:id', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    writeAuditLogMock.mockReset();
    Object.assign(currentUser, {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'manager',
      isPlatformAdmin: false,
    });
  });

  it('returns 404 when the template is missing', async () => {
    installQueryStubs([
      {
        match: (sql) => /SELECT created_by_user_id FROM agent_templates/i.test(sql),
        rows: [],
      },
    ]);
    const app = buildApp();
    const res = await request(app).delete('/agents/templates/custom/missing');
    expect(res.status).toBe(404);
  });

  it('returns 403 when a non-owner manager tries to delete someone else\'s template', async () => {
    installQueryStubs([
      {
        match: (sql) => /SELECT created_by_user_id FROM agent_templates/i.test(sql),
        rows: [{ created_by_user_id: 'other-user' }],
      },
    ]);
    const app = buildApp();
    const res = await request(app).delete('/agents/templates/custom/tpl-1');
    expect(res.status).toBe(403);
  });

  it('owners can delete their own template and an audit row is recorded', async () => {
    installQueryStubs([
      {
        match: (sql) => /SELECT created_by_user_id FROM agent_templates/i.test(sql),
        rows: [{ created_by_user_id: 'user-1' }],
      },
      {
        match: (sql) => /^DELETE FROM agent_templates/i.test(sql),
        rows: [],
        rowCount: 1,
      },
    ]);
    const app = buildApp();
    const res = await request(app).delete('/agents/templates/custom/tpl-1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(writeAuditLogMock.mock.calls[0][0]).toMatchObject({
      action: 'agent_template.deleted',
      resourceId: 'tpl-1',
    });
  });

  it('a platform admin can delete any template in the tenant', async () => {
    Object.assign(currentUser, { role: 'manager', isPlatformAdmin: true });
    installQueryStubs([
      {
        match: (sql) => /SELECT created_by_user_id FROM agent_templates/i.test(sql),
        rows: [{ created_by_user_id: 'someone-else' }],
      },
      {
        match: (sql) => /^DELETE FROM agent_templates/i.test(sql),
        rows: [],
        rowCount: 1,
      },
    ]);
    const app = buildApp();
    const res = await request(app).delete('/agents/templates/custom/tpl-1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});
