import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'migrations/122_scheduling_v2.sql'),
  'utf8',
);

const NEW_TABLES = ['scheduling_provider_services', 'scheduling_business_hours'] as const;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip `--` comments so prose can't satisfy or trip the checks. */
const sql = migration.replace(/--[^\n]*/g, '');

describe('122_scheduling_v2.sql', () => {
  it('enables and forces RLS with fail-closed tenant policies on the new tables', () => {
    for (const table of NEW_TABLES) {
      const name = escaped(table);
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`, 'i'));
      expect(sql).toMatch(new RegExp(
        `CREATE POLICY tenant_isolation_${name} ON ${name}\\s+FOR ALL\\s+USING \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', TRUE\\), ''\\)::varchar\\)\\s+WITH CHECK \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', TRUE\\), ''\\)::varchar\\)`,
        'i',
      ));
    }
    expect(sql).not.toMatch(/USING\s*\(\s*TRUE\s*\)/i);
  });

  it('is expand-only: no dropped/renamed columns or tables, no deleted bookings', () => {
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX|EXTENSION|TYPE)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+\w+\s+(TYPE|DROP)\b/i);
    // The only UPDATE backfills the new column.
    const updates = sql.match(/\bUPDATE\s+bookings\b[^;]*;/gi) ?? [];
    expect(updates).toEqual(['UPDATE bookings SET blocked_until = end_time WHERE blocked_until IS NULL;']);
  });

  it('keeps every existing booking status and adds held', () => {
    const match = sql.match(/ADD CONSTRAINT bookings_status_check\s+CHECK \(status IN \(([^)]*)\)\)/);
    expect(match).not.toBeNull();
    const statuses = match![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    for (const s of ['pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'checked_in', 'rescheduled', 'held']) {
      expect(statuses).toContain(s);
    }
  });

  it('runs the overlap pre-check before any DDL and adds both exclusion constraints after btree_gist', () => {
    const precheck = sql.search(/overlapping held\/confirmed booking pair/);
    const firstAlter = sql.search(/\bALTER TABLE\b/);
    const gist = sql.search(/CREATE EXTENSION IF NOT EXISTS btree_gist/);
    const provider = sql.search(/ADD CONSTRAINT bookings_no_provider_overlap/);
    const resource = sql.search(/ADD CONSTRAINT bookings_no_resource_overlap/);
    expect(precheck).toBeGreaterThan(-1);
    expect(precheck).toBeLessThan(firstAlter);
    expect(gist).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(gist);
    expect(resource).toBeGreaterThan(gist);
    expect(sql).toMatch(
      /EXCLUDE USING gist \(\s*tenant_id WITH =,\s*provider_id WITH =,\s*tstzrange\(start_time, blocked_until\) WITH &&\s*\) WHERE \(status IN \('held', 'confirmed'\) AND provider_id IS NOT NULL\)/,
    );
    expect(sql).toMatch(
      /EXCLUDE USING gist \(\s*tenant_id WITH =,\s*resource_id WITH =,\s*tstzrange\(start_time, blocked_until\) WITH &&\s*\) WHERE \(status IN \('held', 'confirmed'\) AND resource_id IS NOT NULL\)/,
    );
  });

  it('declares the documented columns and keys', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS price_cents INTEGER NULL/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS price_kind TEXT NOT NULL DEFAULT 'hidden'/);
    expect(sql).toMatch(/CHECK \(price_kind IN \('fixed', 'from', 'range', 'hidden'\)\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS price_max_cents INTEGER NULL/);
    expect(sql).toMatch(/PRIMARY KEY \(provider_id, appointment_type_id\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR\(256\)/);
    expect(sql).toMatch(/ALTER COLUMN blocked_until SET NOT NULL/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_tenant_idempotency_key\s+ON bookings \(tenant_id, idempotency_key\)\s+WHERE idempotency_key IS NOT NULL/,
    );
  });
});
