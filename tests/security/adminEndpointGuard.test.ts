import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { requirePlatformAdmin, requireRole } from '../../server/admin-api/middleware/rbac';

interface CapturedRes {
  statusCode: number;
  body: unknown;
}

function makeRes(): { res: Response; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: null };
  const res = {
    status: (code: number) => {
      captured.statusCode = code;
      return {
        json: (body: unknown) => {
          captured.body = body;
        },
      };
    },
  } as unknown as Response;
  return { res, captured };
}

describe('requirePlatformAdmin', () => {
  it('rejects unauthenticated requests with 401', () => {
    const { res, captured } = makeRes();
    let nextCalled = false;
    requirePlatformAdmin({} as Request, res, () => { nextCalled = true; });
    expect(captured.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('rejects non-admin tenant users with 403', () => {
    const req = {
      user: {
        userId: 'u1', tenantId: 't1', email: 'u@test', role: 'tenant_owner',
        isPlatformAdmin: false,
      },
    } as unknown as Request;
    const { res, captured } = makeRes();
    let nextCalled = false;
    requirePlatformAdmin(req, res, () => { nextCalled = true; });
    expect(captured.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('allows users with isPlatformAdmin=true through', () => {
    const req = {
      user: {
        userId: 'u1', tenantId: 't1', email: 'u@test', role: 'support_reviewer',
        isPlatformAdmin: true,
      },
    } as unknown as Request;
    const { res, captured } = makeRes();
    let nextCalled = false;
    requirePlatformAdmin(req, res, () => { nextCalled = true; });
    expect(captured.statusCode).toBe(0);
    expect(nextCalled).toBe(true);
  });
});

describe('requireRole', () => {
  it('rejects viewers from manager-required actions', () => {
    const req = {
      user: { userId: 'u1', tenantId: 't1', email: 'a@b', role: 'support_reviewer', isPlatformAdmin: false },
    } as unknown as Request;
    const { res, captured } = makeRes();
    let nextCalled = false;
    requireRole('manager')(req, res, () => { nextCalled = true; });
    expect(captured.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('allows managers and owners through manager-required actions', () => {
    for (const role of ['operations_manager', 'tenant_owner', 'billing_admin']) {
      const req = {
        user: { userId: 'u1', tenantId: 't1', email: 'a@b', role, isPlatformAdmin: false },
      } as unknown as Request;
      const { res, captured } = makeRes();
      let nextCalled = false;
      requireRole('manager')(req, res, () => { nextCalled = true; });
      expect(captured.statusCode, `role=${role}`).toBe(0);
      expect(nextCalled, `role=${role}`).toBe(true);
    }
  });
});

describe('Admin marketplace/analytics routes are guarded', () => {
  const file = readFileSync(
    join(process.cwd(), 'server/admin-api/routes/marketplace.ts'),
    'utf8',
  );
  const adminFile = readFileSync(
    join(process.cwd(), 'server/admin-api/routes/platformAdmin.ts'),
    'utf8',
  );

  const adminMarketplaceRoutes = [
    "'/platform/templates/:id/versions'",
    "'/platform/templates/:id/versions/:versionId/publish'",
    "'/platform/marketplace/reviews/:reviewId/moderate'",
    "'/platform/marketplace/revenue'",
    "'/platform/marketplace/submissions'",
    "'/platform/marketplace/submissions/:id/review'",
  ];

  const adminAnalyticsRoutes = [
    "'/platform/tenants'",
    "'/platform/stats'",
    "'/platform/template-analytics'",
    "'/platform/cost-monitoring'",
  ];

  for (const route of adminMarketplaceRoutes) {
    it(`marketplace route ${route} requires platform admin`, () => {
      // Find the line that registers this route
      const lines = file.split('\n');
      const idx = lines.findIndex((l) => l.includes(route));
      expect(idx, `route ${route} not registered`).toBeGreaterThan(-1);
      expect(lines[idx]).toMatch(/requireAuth/);
      expect(lines[idx]).toMatch(/requirePlatformAdmin/);
    });
  }

  for (const route of adminAnalyticsRoutes) {
    it(`platformAdmin route ${route} requires platform admin`, () => {
      const lines = adminFile.split('\n');
      const idx = lines.findIndex((l) => l.includes(route));
      expect(idx, `route ${route} not registered`).toBeGreaterThan(-1);
      expect(lines[idx]).toMatch(/requireAuth/);
      expect(lines[idx]).toMatch(/requirePlatformAdmin/);
    });
  }

  const toolExecutionsFile = readFileSync(
    join(process.cwd(), 'server/admin-api/routes/toolExecutions.ts'),
    'utf8',
  );

  it('global tool registry route /platform/tools/registry requires platform admin', () => {
    const lines = toolExecutionsFile.split('\n');
    const idx = lines.findIndex((l) => l.includes("'/platform/tools/registry'"));
    expect(idx, 'route /platform/tools/registry not registered').toBeGreaterThan(-1);
    expect(lines[idx]).toMatch(/requireAuth/);
    expect(lines[idx]).toMatch(/requirePlatformAdmin/);
  });

  it('tenant-scoped tool registry route /tools/registry does not require platform admin', () => {
    const lines = toolExecutionsFile.split('\n');
    const idx = lines.findIndex((l) => /router\.get\(\s*'\/tools\/registry'/.test(l));
    expect(idx, 'route /tools/registry not registered').toBeGreaterThan(-1);
    expect(lines[idx]).toMatch(/requireAuth/);
    expect(lines[idx]).not.toMatch(/requirePlatformAdmin/);
  });
});

describe('Tenant routes never trust URL/query tenant_id', () => {
  it('tenantGuard rejects mismatched query tenantId', async () => {
    const { requireTenantContext } = await import('../../server/admin-api/middleware/tenantGuard');
    const req = {
      user: { userId: 'u1', tenantId: 'tenant-a', email: 'a@b', role: 'tenant_owner', isPlatformAdmin: false },
      body: {},
      query: { tenantId: 'tenant-b' },
      path: '/test',
    } as unknown as Request;
    const { res, captured } = makeRes();
    let nextCalled = false;
    requireTenantContext(req, res, () => { nextCalled = true; });
    expect(captured.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('tenantGuard allows platform admins to query other tenants', async () => {
    const { requireTenantContext } = await import('../../server/admin-api/middleware/tenantGuard');
    const req = {
      user: { userId: 'u1', tenantId: 'tenant-a', email: 'a@b', role: 'tenant_owner', isPlatformAdmin: true },
      body: {},
      query: { tenantId: 'tenant-b' },
      path: '/test',
    } as unknown as Request;
    const { res } = makeRes();
    let nextCalled = false;
    requireTenantContext(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});
