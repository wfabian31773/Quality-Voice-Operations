// Verifies that provisioning a brand-new tenant seeds the starter
// dispatch SMS template pack — including the en_route template that
// contains the {{tracking_url}} token — and that the seed is
// idempotent on re-provision.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ connect: connectMock }),
}));
vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe('provisionTenant dispatch template seeding', () => {
  it('seeds the five starter dispatch templates for a new tenant, including en_route with {{tracking_url}}', async () => {
    const { provisionTenant, DEFAULT_DISPATCH_TEMPLATES } = await import(
      '../../platform/tenant/provisioning/TenantProvisioningService'
    );

    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.startsWith('BEGIN')) return { rows: [] };
      if (text.startsWith('SET LOCAL')) return { rows: [] };
      if (text.includes('FROM tenants WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: 'tenant-1', status: 'pending' }] };
      }
      if (text.includes("UPDATE tenants SET status = 'provisioning'")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM agents WHERE tenant_id = $1 LIMIT 1')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO agents')) {
        return { rows: [{ id: 'agent-1' }] };
      }
      if (text.includes('FROM user_roles')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO user_roles')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM dispatch_notification_templates')) {
        // No existing templates -> seeding will run
        return { rows: [] };
      }
      if (text.includes('INSERT INTO dispatch_notification_templates')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("UPDATE tenants SET status = 'active'")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO audit_logs')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('COMMIT')) return { rows: [] };
      if (text.startsWith('ROLLBACK')) return { rows: [] };
      return { rows: [] };
    });

    const result = await provisionTenant('tenant-1', 'user-1', 'starter');
    expect(result.status).toBe('ready');
    expect(result.agentId).toBe('agent-1');

    // Five default templates inserted.
    const inserts = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO dispatch_notification_templates'),
    );
    expect(inserts).toHaveLength(DEFAULT_DISPATCH_TEMPLATES.length);
    expect(DEFAULT_DISPATCH_TEMPLATES).toHaveLength(5);

    // Trigger events cover the dispatch lifecycle.
    const triggers = inserts.map(([, params]) => (params as unknown[])[2]);
    expect(triggers.sort()).toEqual(
      ['arrival', 'completed', 'en_route', 'job_assigned', 'job_scheduled'].sort(),
    );

    // Every seeded template is SMS, active, and tied to the tenant.
    for (const [, params] of inserts) {
      const [tenantId, , , channel] = params as unknown[];
      expect(tenantId).toBe('tenant-1');
      expect(channel).toBe('sms');
    }

    // The en_route template carries the public tracker token so
    // fireNotifications can substitute the booking-tracker link.
    const enRouteInsert = inserts.find(
      ([, params]) => (params as unknown[])[2] === 'en_route',
    );
    expect(enRouteInsert).toBeTruthy();
    const enRouteBody = (enRouteInsert![1] as unknown[])[5] as string;
    expect(enRouteBody).toContain('{{tracking_url}}');

    // Audit log records how many templates were seeded so platform
    // operators can tell at a glance which tenants got the pack.
    const auditCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO audit_logs'),
    );
    expect(auditCall).toBeTruthy();
    const auditPayload = JSON.parse((auditCall![1] as unknown[])[2] as string);
    expect(auditPayload.seededDispatchTemplates).toBe(5);
  });

  it('does not insert default templates when the tenant already has one (idempotent)', async () => {
    const { provisionTenant } = await import(
      '../../platform/tenant/provisioning/TenantProvisioningService'
    );

    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.startsWith('BEGIN')) return { rows: [] };
      if (text.startsWith('SET LOCAL')) return { rows: [] };
      if (text.includes('FROM tenants WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: 'tenant-2', status: 'pending' }] };
      }
      if (text.includes("UPDATE tenants SET status = 'provisioning'")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM agents WHERE tenant_id = $1 LIMIT 1')) {
        return { rows: [{ id: 'agent-existing' }] };
      }
      if (text.includes('FROM user_roles')) {
        return { rows: [{ id: 'role-existing' }] };
      }
      if (text.includes('FROM dispatch_notification_templates')) {
        // Tenant already has templates (e.g. backfilled by migration 089
        // or seeded manually) -> seed should skip.
        return { rows: [{ '?column?': 1 }] };
      }
      if (text.includes('INSERT INTO dispatch_notification_templates')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("UPDATE tenants SET status = 'active'")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO audit_logs')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('COMMIT')) return { rows: [] };
      if (text.startsWith('ROLLBACK')) return { rows: [] };
      return { rows: [] };
    });

    await provisionTenant('tenant-2', 'user-2', 'starter');

    const inserts = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO dispatch_notification_templates'),
    );
    expect(inserts).toHaveLength(0);

    const auditCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO audit_logs'),
    );
    const auditPayload = JSON.parse((auditCall![1] as unknown[])[2] as string);
    expect(auditPayload.seededDispatchTemplates).toBe(0);
  });
});
