import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ProbeDb {
  connectedRole: string;
  bypassesRls: boolean;
  /** Other-tenant rows COUNT(*) sees as the connected role. */
  visibleAsConnected: number;
  /** Other-tenant rows COUNT(*) sees as platform_rls_tester. */
  visibleAsTester: number;
  setRoleError: Error | null;
  testerCountError: Error | null;
  /** One list of client statements per checked-out connection. */
  connections: string[][];
}

const db = vi.hoisted(() => ({ state: null as unknown as ProbeDb }));

function makeClient() {
  const statements: string[] = [];
  db.state.connections.push(statements);
  let actingAsTester = false;
  return {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('bypasses_rls')) {
        return { rows: [{ rolname: db.state.connectedRole, bypasses_rls: db.state.bypassesRls }] };
      }
      if (sql.startsWith('SET LOCAL ROLE')) {
        if (db.state.setRoleError) throw db.state.setRoleError;
        actingAsTester = true;
        return { rows: [] };
      }
      if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
        actingAsTester = false;
        return { rows: [] };
      }
      if (sql.includes('COUNT(*)')) {
        if (actingAsTester && db.state.testerCountError) throw db.state.testerCountError;
        const cnt = actingAsTester ? db.state.visibleAsTester : db.state.visibleAsConnected;
        return { rows: [{ cnt: String(cnt) }] };
      }
      return { rows: [] };
    }),
  };
}

async function poolQuery(sql: string) {
  if (sql.includes('rolbypassrls, rolsuper')) {
    return {
      rows: [{ rolname: db.state.connectedRole, rolbypassrls: db.state.bypassesRls, rolsuper: false }],
    };
  }
  if (sql.includes('relrowsecurity')) return { rows: [{ relrowsecurity: true }] };
  return { rows: [] };
}

vi.mock('../db', () => ({
  getPlatformPool: () => ({ query: poolQuery, connect: async () => makeClient() }),
  getPrivilegedPool: () => ({ query: poolQuery }),
  withPrivilegedClient: async (fn: (c: { query: typeof poolQuery }) => Promise<unknown>) =>
    fn({ query: poolQuery }),
}));

vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { CROSS_TENANT_READ_TABLES, runAllIsolationTests } from './TenantIsolationService';

const TENANT = 'tenant-self';

async function crossTenantResults() {
  const { results } = await runAllIsolationTests(TENANT, { source: 'scheduled' });
  return results.filter((r) => r.testName.startsWith('Cross-tenant read blocked on '));
}

beforeEach(() => {
  db.state = {
    connectedRole: 'postgres',
    bypassesRls: true,
    visibleAsConnected: 15,
    visibleAsTester: 0,
    setRoleError: null,
    testerCountError: null,
    connections: [],
  };
});

describe('cross-tenant read probe', () => {
  it('probes agents, audit_logs, api_keys, bookings, tickets, action_proposals under unchanged test names', async () => {
    expect(CROSS_TENANT_READ_TABLES).toEqual([
      'agents', 'audit_logs', 'api_keys', 'bookings', 'tickets', 'action_proposals',
    ]);
    const results = await crossTenantResults();
    expect(results.map((r) => r.testName)).toEqual(
      CROSS_TENANT_READ_TABLES.map((t) => `Cross-tenant read blocked on ${t}`),
    );
  });

  it('switches to platform_rls_tester inside a savepoint when the connection bypasses RLS', async () => {
    const results = await crossTenantResults();

    expect(db.state.connections).toHaveLength(CROSS_TENANT_READ_TABLES.length);
    for (const statements of db.state.connections) {
      const setConfig = statements.findIndex((s) => s.includes(`set_config('app.tenant_id'`));
      const savepoint = statements.indexOf('SAVEPOINT rls_probe');
      const setRole = statements.indexOf('SET LOCAL ROLE platform_rls_tester');
      const count = statements.findIndex((s) => s.includes('COUNT(*)'));
      expect(statements[0]).toBe('BEGIN');
      expect(setConfig).toBeGreaterThan(0);
      expect(savepoint).toBeGreaterThan(setConfig);
      expect(setRole).toBe(savepoint + 1);
      expect(count).toBeGreaterThan(setRole);
      expect(statements.at(-1)).toBe('COMMIT');
    }
    for (const r of results) {
      expect(r.passed).toBe(true);
      expect(r.details).toBe('RLS correctly prevents cross-tenant reads (evaluated as platform_rls_tester)');
    }
  });

  it('still fails with VIOLATION when other-tenant rows are visible to platform_rls_tester', async () => {
    db.state.visibleAsTester = 2;
    const [agents] = await crossTenantResults();
    expect(agents.passed).toBe(false);
    expect(agents.details).toBe('VIOLATION: 2 rows from other tenants visible (evaluated as platform_rls_tester)');
  });

  it('tests a role that does not bypass RLS as itself (no savepoint, no SET ROLE)', async () => {
    db.state.connectedRole = 'qvo_app';
    db.state.bypassesRls = false;
    db.state.visibleAsConnected = 0;
    const results = await crossTenantResults();

    for (const statements of db.state.connections) {
      expect(statements).not.toContain('SAVEPOINT rls_probe');
      expect(statements.some((s) => s.startsWith('SET LOCAL ROLE'))).toBe(false);
      expect(statements.some((s) => s.includes('COUNT(*)'))).toBe(true);
    }
    for (const r of results) {
      expect(r.passed).toBe(true);
      expect(r.details).toBe('RLS correctly prevents cross-tenant reads (evaluated as qvo_app)');
    }
  });

  it('falls back to the connected role when SET ROLE fails, and says the result cannot detect leaks', async () => {
    db.state.setRoleError = new Error('permission denied to set role "platform_rls_tester"');
    const results = await crossTenantResults();

    for (const statements of db.state.connections) {
      const setRole = statements.indexOf('SET LOCAL ROLE platform_rls_tester');
      expect(statements[setRole + 1]).toBe('ROLLBACK TO SAVEPOINT rls_probe');
      expect(statements.slice(setRole + 2).some((s) => s.includes('COUNT(*)'))).toBe(true);
      expect(statements.at(-1)).toBe('COMMIT');
    }
    // Same outcome as before the switch existed: postgres sees the rows.
    for (const r of results) {
      expect(r.passed).toBe(false);
      expect(r.details).toContain('VIOLATION: 15 rows from other tenants visible');
      expect(r.details).toContain('evaluated as connected role "postgres", which bypasses RLS');
      expect(r.details).toContain('cannot detect leaks');
      expect(r.details).toContain('SET ROLE platform_rls_tester failed');
    }
  });

  it('keeps a zero count passing on fallback, without claiming RLS prevented anything', async () => {
    db.state.setRoleError = new Error('role "platform_rls_tester" does not exist');
    db.state.visibleAsConnected = 0;
    const [agents] = await crossTenantResults();
    expect(agents.passed).toBe(true);
    expect(agents.details).toMatch(/^No rows from other tenants visible \(evaluated as connected role "postgres"/);
    expect(agents.details).not.toContain('RLS correctly prevents');
  });

  it('does not count a tester permission error as an RLS block; recounts as the connected role', async () => {
    db.state.testerCountError = new Error('permission denied for table agents');
    const [agents] = await crossTenantResults();

    const statements = db.state.connections[0];
    const counts = statements.filter((s) => s.includes('COUNT(*)'));
    expect(counts).toHaveLength(2);
    expect(statements.indexOf('ROLLBACK TO SAVEPOINT rls_probe')).toBeGreaterThan(
      statements.indexOf('SET LOCAL ROLE platform_rls_tester'),
    );
    expect(agents.passed).toBe(false);
    expect(agents.details).not.toContain('Query blocked by RLS policy');
    expect(agents.details).toContain('evaluated as connected role "postgres"');
    expect(agents.details).toContain('platform_rls_tester could not read agents');
  });
});
