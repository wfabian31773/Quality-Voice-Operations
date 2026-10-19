import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'migrations/128_plans_all_verticals.sql'),
  'utf8',
);
const statements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

describe('migration 128: every template on every plan', () => {
  it('is data only: no schema, constraint or drop statements', () => {
    expect(statements).toHaveLength(3);
    for (const s of statements) {
      expect(s).toMatch(/^(UPDATE|INSERT INTO) template_(registry|entitlements)\b/);
    }
    expect(migration).not.toMatch(/\b(DROP|ALTER|CREATE|TRUNCATE|DELETE)\b/);
  });

  it('sets min_plan to starter and touches only rows that still differ', () => {
    expect(statements[0]).toMatch(/UPDATE template_registry\s+SET min_plan = 'starter'/);
    expect(statements[0]).toMatch(/WHERE min_plan <> 'starter'$/);
  });

  it('enables disabled entitlement rows and touches only those', () => {
    expect(statements[1]).toMatch(/UPDATE template_entitlements\s+SET enabled = TRUE\s+WHERE enabled = FALSE$/);
  });

  it('inserts any missing (template, tier) row as enabled, idempotently', () => {
    const insert = statements[2];
    expect(insert).toMatch(/INSERT INTO template_entitlements \(template_id, plan_tier, enabled\)/);
    expect(insert).toMatch(/\('starter'\), \('pro'\), \('enterprise'\)/);
    expect(insert).toMatch(/ON CONFLICT \(template_id, plan_tier\) DO UPDATE SET enabled = TRUE\s+WHERE template_entitlements\.enabled = FALSE$/);
  });
});
