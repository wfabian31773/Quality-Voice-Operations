/**
 * Federal DNC registry integration coverage for the campaign compliance flow.
 *
 * Locks down three behaviors added in task #603:
 *   1. The pre-flight check consults `federal_dnc_numbers` alongside the
 *      tenant `dnc_list` and returns a `dncMatches` entry tagged with
 *      `source: 'federal'` plus `federalDncMatchCount` / registry version.
 *   2. `isContactOnDnc` returns `{ source: 'federal', registryVersion }` for
 *      numbers that are only on the federal list — so the dial-time
 *      defense-in-depth checks know which list to attribute the block to.
 *   3. PATCH /campaigns/:id launch-block surfaces the federal subtotal in
 *      the error message and writes a `campaign.launch_blocked` audit row
 *      that records the federal count + registry version.
 *
 * The DB layer is mocked: each query is matched by a regex and routed to a
 * stubbed result set. The default fall-through returns `{ rows: [] }`, so
 * any query we don't explicitly stub behaves as "no row found" — that's
 * what we want for federal lookups in the pure tenant-DNC tests too.
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

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn()),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/security/FieldEncryption', () => ({
  encryptSensitiveField: vi.fn(async (_t: string, v: string) => v),
  decryptSensitiveField: vi.fn(async (_t: string, v: string) =>
    v.startsWith('env1:') ? v.slice('env1:'.length) : v,
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

const { writeAuditLogMock } = vi.hoisted(() => ({ writeAuditLogMock: vi.fn(async () => {}) }));
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: writeAuditLogMock,
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../platform/telephony/TrustedCallerService', () => ({
  getVerifiedCallerById: vi.fn(async () => null),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'admin',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import campaignsRouter from '../../server/admin-api/routes/campaigns';
import {
  checkCampaignCompliance,
  isContactOnDnc,
} from '../../platform/campaigns/ComplianceService';
import { clearFederalDncVersionCache } from '../../platform/campaigns/FederalDncService';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(campaignsRouter);
  return app;
}

const sampleCampaignRow = {
  id: 'camp-1',
  tenant_id: 'tenant-1',
  agent_id: 'agent-1',
  name: 'Outbound test',
  type: 'outbound_call',
  status: 'draft',
  config: { timezone: 'America/New_York', callWindowStart: '09:00', callWindowEnd: '20:00' },
  scheduled_at: null,
  started_at: null,
  completed_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  writeAuditLogMock.mockReset();
  // The federal DNC version is cached in-process; clear it between tests so
  // a stub from one test doesn't leak into the next.
  clearFederalDncVersionCache();
});

describe('checkCampaignCompliance: federal DNC integration', () => {
  it('flags federal-only matches with source=federal and reports the registry version', async () => {
    queryMock.mockImplementation(async (sql: string, _values?: unknown[]) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      // Tenant DNC is empty — only the federal list will match.
      if (/SELECT phone_number FROM dnc_list/i.test(sql)) return { rows: [], rowCount: 0 };
      // getCurrentFederalDncVersion
      if (/SELECT last_registry_version FROM federal_dnc_sync_state/i.test(sql)) {
        return { rows: [{ last_registry_version: 'v2026-04-20' }], rowCount: 1 };
      }
      // Counts
      if (/COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql)) {
        return { rows: [{ total: 2, opted_out: 0 }], rowCount: 1 };
      }
      // Roster batch
      if (/SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql)) {
        return {
          rows: [
            { id: 'c1', phone_number: 'env1:+15551110001', name: 'On Federal', created_at: '2026-04-27T00:00:00Z' },
            { id: 'c2', phone_number: 'env1:+15552220002', name: 'Clean', created_at: '2026-04-27T00:00:01Z' },
          ],
          rowCount: 2,
        };
      }
      // Federal batch lookup — return only the first contact's number.
      if (/SELECT phone_number FROM federal_dnc_numbers WHERE phone_number = ANY/i.test(sql)) {
        return { rows: [{ phone_number: '+15551110001' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await checkCampaignCompliance('tenant-1', 'camp-1', {
      config: sampleCampaignRow.config,
    } as Parameters<typeof checkCampaignCompliance>[2]);

    expect(result.dncMatchCount).toBe(1);
    expect(result.tenantDncMatchCount).toBe(0);
    expect(result.federalDncMatchCount).toBe(1);
    expect(result.federalDncRegistryVersion).toBe('v2026-04-20');
    expect(result.dncMatches[0]).toMatchObject({ contactId: 'c1', source: 'federal' });
    // Recommendation should distinguish federal vs tenant for the operator.
    expect(result.recommendations.some((r) => /federal DNC registry/i.test(r))).toBe(true);
  });

  it('prefers source=tenant when a number is on both the tenant and federal lists', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT phone_number FROM dnc_list/i.test(sql)) {
        return { rows: [{ phone_number: '+15551110001' }], rowCount: 1 };
      }
      if (/SELECT last_registry_version FROM federal_dnc_sync_state/i.test(sql)) {
        return { rows: [{ last_registry_version: 'v2026-04-20' }], rowCount: 1 };
      }
      if (/COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql)) {
        return { rows: [{ total: 1, opted_out: 0 }], rowCount: 1 };
      }
      if (/SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql)) {
        return {
          rows: [
            { id: 'c1', phone_number: 'env1:+15551110001', name: 'On Both', created_at: '2026-04-27T00:00:00Z' },
          ],
          rowCount: 1,
        };
      }
      // Federal claims the number is on its list too.
      if (/SELECT phone_number FROM federal_dnc_numbers WHERE phone_number = ANY/i.test(sql)) {
        return { rows: [{ phone_number: '+15551110001' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await checkCampaignCompliance('tenant-1', 'camp-1', {
      config: sampleCampaignRow.config,
    } as Parameters<typeof checkCampaignCompliance>[2]);

    // Single contact, single match — but tenant takes priority for the source label.
    expect(result.dncMatchCount).toBe(1);
    expect(result.tenantDncMatchCount).toBe(1);
    expect(result.federalDncMatchCount).toBe(0);
    expect(result.dncMatches[0].source).toBe('tenant');
  });
});

describe('isContactOnDnc: federal source attribution', () => {
  it('reports source=federal with the registry version when only federal matches', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      // Tenant lookup misses
      if (/SELECT 1 FROM dnc_list/i.test(sql)) return { rows: [], rowCount: 0 };
      // Federal single-number lookup hits
      if (/SELECT registry_version FROM federal_dnc_numbers WHERE phone_number/i.test(sql)) {
        return { rows: [{ registry_version: 'v2026-04-20' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await isContactOnDnc('tenant-1', '+15551110001');
    expect(result.onDnc).toBe(true);
    expect(result.source).toBe('federal');
    expect(result.registryVersion).toBe('v2026-04-20');
  });

  it('reports source=tenant (registryVersion=null) when tenant DNC matches', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM dnc_list/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await isContactOnDnc('tenant-1', '+15551110001');
    expect(result.onDnc).toBe(true);
    expect(result.source).toBe('tenant');
    expect(result.registryVersion).toBeNull();
  });

  it('returns onDnc=false when neither list matches', async () => {
    queryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    const result = await isContactOnDnc('tenant-1', '+15551110001');
    expect(result.onDnc).toBe(false);
    expect(result.source).toBeNull();
  });
});

describe('PATCH /campaigns/:id launch block: federal subtotal & audit', () => {
  it('records federal counts in the launch_blocked audit row and includes them in the error message', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/phone_verified FROM users/i.test(sql)) return { rows: [{ phone_verified: true }], rowCount: 1 };
      if (/SELECT \* FROM campaigns WHERE id = \$1/i.test(sql)) return { rows: [sampleCampaignRow], rowCount: 1 };
      if (/SELECT phone_number FROM dnc_list/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT last_registry_version FROM federal_dnc_sync_state/i.test(sql)) {
        return { rows: [{ last_registry_version: 'v2026-04-20' }], rowCount: 1 };
      }
      if (/COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql)) {
        return { rows: [{ total: 1, opted_out: 0 }], rowCount: 1 };
      }
      if (/SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql)) {
        return {
          rows: [
            { id: 'c1', phone_number: 'env1:+15551110001', name: 'Federal', created_at: '2026-04-27T00:00:00Z' },
          ],
          rowCount: 1,
        };
      }
      if (/SELECT phone_number FROM federal_dnc_numbers WHERE phone_number = ANY/i.test(sql)) {
        return { rows: [{ phone_number: '+15551110001' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = buildApp();
    const res = await request(app).patch('/campaigns/camp-1').send({ status: 'running' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/do-not-call/i);
    expect(res.body.error).toMatch(/federal DNC registry/i);
    expect(res.body.compliance.federalDncMatchCount).toBe(1);
    expect(res.body.compliance.federalDncRegistryVersion).toBe('v2026-04-20');

    expect(writeAuditLogMock).toHaveBeenCalled();
    const auditCall = writeAuditLogMock.mock.calls.find(
      (c) => (c[0] as { action: string }).action === 'campaign.launch_blocked',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![0]).toMatchObject({
      action: 'campaign.launch_blocked',
      afterState: expect.objectContaining({
        federalDncMatchCount: 1,
        federalDncRegistryVersion: 'v2026-04-20',
      }),
    });
  });
});
