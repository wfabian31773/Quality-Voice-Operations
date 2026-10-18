import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  getPlatformPool: vi.fn(),
  getPrivilegedPool: vi.fn(),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { CROSS_TENANT_READ_TABLES, RLS_TABLES } from './TenantIsolationService';

/** Migrations from the action layer on; earlier ones predate this check. */
const FIRST_WATCHED_MIGRATION = 121;

function tablesGivenRlsInMigrationsFrom(first: number): Map<string, string> {
  const dir = join(process.cwd(), 'migrations');
  const found = new Map<string, string>();
  for (const file of readdirSync(dir).sort()) {
    const num = /^(\d+)_.*\.sql$/.exec(file);
    if (!num || Number(num[1]) < first) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
    for (const m of sql.matchAll(re)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

describe('RLS_TABLES coverage', () => {
  it(`includes every table that migrations ${FIRST_WATCHED_MIGRATION}+ put under RLS`, () => {
    const found = tablesGivenRlsInMigrationsFrom(FIRST_WATCHED_MIGRATION);
    // Guards the parser itself: 121 and 122 enable RLS on five tables.
    expect(found.size).toBeGreaterThanOrEqual(5);
    const missing = [...found].filter(([table]) => !RLS_TABLES.includes(table)).map(([t, f]) => `${t} (${f})`);
    expect(missing, 'add these to RLS_TABLES in TenantIsolationService.ts').toEqual([]);
  });

  it('watches the action-layer and scheduling tables', () => {
    expect(RLS_TABLES).toEqual(expect.arrayContaining([
      'action_idempotency', 'action_proposals', 'action_audit_log',
      'bookings', 'scheduling_provider_services', 'scheduling_business_hours',
    ]));
    expect(new Set(RLS_TABLES).size).toBe(RLS_TABLES.length);
  });

  it('only probes cross-tenant reads on tables it also checks for RLS', () => {
    for (const table of CROSS_TENANT_READ_TABLES) expect(RLS_TABLES).toContain(table);
  });
});
