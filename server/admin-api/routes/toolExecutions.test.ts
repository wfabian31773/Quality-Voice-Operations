import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  listToolExecutionsMock: vi.fn(),
  getToolExecutionMock: vi.fn(),
  getToolExecutionStatsMock: vi.fn(),
  getRegistrySnapshotMock: vi.fn(),
  poolQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  getTemplatePermissionsMock: vi.fn(),
  getAllKnownToolsMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// keep the real (pure) rbac middleware so role gates are actually exercised
vi.mock('../../../platform/tools/ToolExecutionService', () => ({
  listToolExecutions: a.listToolExecutionsMock,
  getToolExecution: a.getToolExecutionMock,
  getToolExecutionStats: a.getToolExecutionStatsMock,
}));
vi.mock('../../../platform/tools/ToolRegistry', () => ({
  unifiedToolRegistry: { getRegistrySnapshot: a.getRegistrySnapshotMock },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.poolQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/agent-templates/toolPermissions', () => ({
  getTemplatePermissions: a.getTemplatePermissionsMock,
  getAllKnownTools: a.getAllKnownToolsMock,
}));

import toolExecutionsRouter from './toolExecutions';

function app() {
  const app = express();
  app.use(express.json());
  app.use(toolExecutionsRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.isPlatformAdmin = false;
  a.listToolExecutionsMock.mockReset().mockResolvedValue({ executions: [], total: 0 });
  a.getToolExecutionMock.mockReset();
  a.getToolExecutionStatsMock.mockReset().mockResolvedValue({ totalExecutions: 0 });
  a.getRegistrySnapshotMock.mockReset().mockReturnValue([]);
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.getTemplatePermissionsMock.mockReset().mockReturnValue({ allowedTools: [], deniedTools: [] });
  a.getAllKnownToolsMock.mockReset().mockReturnValue([]);
});

describe('GET /tool-executions', () => {
  it('returns a paged execution list', async () => {
    a.listToolExecutionsMock.mockResolvedValue({ executions: [{ id: 'e1' }], total: 12 });
    const res = await request(app()).get('/tool-executions?limit=5&page=2&status=success');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 12, limit: 5, page: 2, totalPages: 3 });
    expect(a.listToolExecutionsMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', status: 'success', offset: 5 }));
  });

  it('returns 500 on failure', async () => {
    a.listToolExecutionsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/tool-executions')).status).toBe(500);
  });
});

describe('GET /tool-executions/stats', () => {
  it('maps the window and returns stats', async () => {
    a.getToolExecutionStatsMock.mockResolvedValue({ totalExecutions: 9 });
    const res = await request(app()).get('/tool-executions/stats?window=24h');
    expect(res.body).toMatchObject({ window: '24h', totalExecutions: 9 });
    expect(a.getToolExecutionStatsMock).toHaveBeenCalledWith('t1', 1);
  });
});

describe('GET /tool-executions/:id', () => {
  it('returns the execution when found', async () => {
    a.getToolExecutionMock.mockResolvedValue({ id: 'exec-1', toolName: 'lookup_customer' });
    const res = await request(app()).get('/tool-executions/exec-1');
    expect(res.body.execution).toMatchObject({ id: 'exec-1' });
  });

  it('returns 404 when not found', async () => {
    a.getToolExecutionMock.mockResolvedValue(null);
    expect((await request(app()).get('/tool-executions/missing')).status).toBe(404);
  });
});

describe('POST /tool-executions/:id/replay', () => {
  it('returns a dry-run replay for a manager', async () => {
    a.getToolExecutionMock.mockResolvedValue({ id: 'exec-1', toolName: 'lookup_customer', parametersRedacted: { a: 1 } });
    const res = await request(app()).post('/tool-executions/exec-1/replay');
    expect(res.status).toBe(200);
    expect(res.body.replay.mode).toBe('dry-run');
    expect(res.body.replay.wouldExecute.toolName).toBe('lookup_customer');
  });

  it('rejects a viewer with 403 (real rbac gate)', async () => {
    a.user.role = 'support_reviewer';
    const res = await request(app()).post('/tool-executions/exec-1/replay');
    expect(res.status).toBe(403);
  });

  it('returns 404 when the execution is missing', async () => {
    a.getToolExecutionMock.mockResolvedValue(null);
    expect((await request(app()).post('/tool-executions/missing/replay')).status).toBe(404);
  });
});

describe('GET /tools/registry', () => {
  it('returns the registry snapshot filtered to tools enabled for the tenant', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agents')) return { rows: [{ id: 'a1', type: 'dental' }] };
      if (sql.includes('FROM agent_tools')) return { rows: [] };
      return { rows: [] };
    });
    a.getAllKnownToolsMock.mockReturnValue(['lookup_customer', 'create_campaign']);
    a.getTemplatePermissionsMock.mockReturnValue({ allowedTools: ['lookup_customer'], deniedTools: ['create_campaign'] });
    a.getRegistrySnapshotMock.mockReturnValue([
      { name: 'lookup_customer' },
      { name: 'create_campaign' },
    ]);
    const res = await request(app()).get('/tools/registry');
    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual([{ name: 'lookup_customer' }]);
  });

  it('respects per-agent tool overrides', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agents')) return { rows: [{ id: 'a1', type: 'dental' }] };
      if (sql.includes('FROM agent_tools')) return { rows: [{ agent_id: 'a1', tool_name: 'create_campaign', is_enabled: true }] };
      return { rows: [] };
    });
    a.getAllKnownToolsMock.mockReturnValue(['create_campaign']);
    a.getTemplatePermissionsMock.mockReturnValue({ allowedTools: [], deniedTools: ['create_campaign'] });
    a.getRegistrySnapshotMock.mockReturnValue([{ name: 'create_campaign' }]);
    const res = await request(app()).get('/tools/registry');
    expect(res.body.tools).toEqual([{ name: 'create_campaign' }]);
  });

  it('returns 500 and rolls back on DB error', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/tools/registry')).status).toBe(500);
  });
});

describe('GET /platform/tools/registry', () => {
  it('returns the full snapshot for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    a.getRegistrySnapshotMock.mockReturnValue([{ name: 'lookup_customer' }, { name: 'create_campaign' }]);
    const res = await request(app()).get('/platform/tools/registry');
    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(2);
  });

  it('rejects a non-platform-admin with 403', async () => {
    const res = await request(app()).get('/platform/tools/registry');
    expect(res.status).toBe(403);
  });
});
