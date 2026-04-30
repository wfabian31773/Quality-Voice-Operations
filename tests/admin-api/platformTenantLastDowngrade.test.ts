import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  ),
  withPrivilegedClient: vi.fn(
    async (fn: (c: { query: typeof queryMock }) => Promise<unknown>) => {
      await queryMock('BEGIN');
      await queryMock('SET LOCAL row_security = off');
      try {
        const result = await fn({ query: queryMock });
        await queryMock('COMMIT');
        return result;
      } catch (err) {
        await queryMock('ROLLBACK');
        throw err;
      }
    },
  ),
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
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../platform/messaging/SlackWebhookNotifier', () => ({
  postToOpsSlackWebhook: vi.fn(),
  getOpsSlackWebhookUrl: vi.fn(() => null),
}));
vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-x',
      userId: 'user-x',
      role: 'platform_admin',
      isPlatformAdmin: true,
      email: 'admin@acme.test',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import platformAdminRoutes from '../../server/admin-api/routes/platformAdmin';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(platformAdminRoutes);
  return app;
}

describe('GET /platform/tenants/:id — last_downgrade_at', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
  });

  it('returns the most recent downgrade timestamp from audit_logs alongside the tenant row', async () => {
    const downgradeAt = new Date('2026-04-15T18:23:11Z');
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (/FROM tenants t\s+WHERE t\.id = \$1/i.test(s)) {
        expect(params).toEqual(['tenant-abc']);
        expect(s).toMatch(/billing\.checkout_created/);
        expect(s).toMatch(/billing\.downgrade_scheduled/);
        expect(s).toMatch(/changes->>'direction'\s*=\s*'downgrade'/);
        return {
          rows: [
            {
              id: 'tenant-abc',
              name: 'Acme Co',
              slug: 'acme',
              status: 'active',
              plan: 'pro',
              created_at: new Date('2026-01-01T00:00:00Z'),
              updated_at: new Date('2026-04-15T18:23:11Z'),
              user_count: '5',
              agent_count: '3',
              phone_number_count: '2',
              total_calls: '120',
              total_cost_cents: '4500',
              last_downgrade_at: downgradeAt,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/platform/tenants/tenant-abc');

    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe('tenant-abc');
    expect(res.body.tenant.last_downgrade_at).toBe(downgradeAt.toISOString());
  });

  it('returns last_downgrade_at = null when the tenant has never downgraded', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/FROM tenants t\s+WHERE t\.id = \$1/i.test(s)) {
        return {
          rows: [
            {
              id: 'tenant-fresh',
              name: 'Fresh Co',
              slug: 'fresh',
              status: 'active',
              plan: 'starter',
              created_at: new Date('2026-04-01T00:00:00Z'),
              updated_at: new Date('2026-04-01T00:00:00Z'),
              user_count: '1',
              agent_count: '0',
              phone_number_count: '0',
              total_calls: '0',
              total_cost_cents: '0',
              last_downgrade_at: null,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/platform/tenants/tenant-fresh');

    expect(res.status).toBe(200);
    expect(res.body.tenant.last_downgrade_at).toBeNull();
  });
});
