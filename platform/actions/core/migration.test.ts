import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'migrations/121_action_layer.sql'),
  'utf8',
);

const TABLES = ['action_idempotency', 'action_proposals', 'action_audit_log'] as const;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('121_action_layer.sql', () => {
  it('enables and forces RLS on all three action tables', () => {
    for (const table of TABLES) {
      const name = escaped(table);
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`, 'i'));
    }
  });

  it('creates fail-closed tenant policies on current_setting app.tenant_id', () => {
    for (const table of TABLES) {
      const name = escaped(table);
      expect(migration).toMatch(new RegExp(
        `CREATE POLICY tenant_isolation_${name}[\\s\\S]*ON ${name}[\\s\\S]*FOR ALL[\\s\\S]*USING \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', TRUE\\), ''\\)::varchar\\)[\\s\\S]*WITH CHECK \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', TRUE\\), ''\\)::varchar\\)`,
        'i',
      ));
    }
    expect(migration).not.toMatch(/USING\s*\(\s*TRUE\s*\)/i);
    expect(migration).not.toMatch(/tenant_id\s+IS\s+NULL\s+OR/i);
  });

  it('declares the documented uniqueness, proposal token, and audit columns', () => {
    expect(migration).toMatch(/PRIMARY KEY \(tenant_id, action, key\)/);
    expect(migration).toMatch(/id UUID PRIMARY KEY/);
    expect(migration).toMatch(/input_redacted JSONB NOT NULL/);
    expect(migration).toMatch(/result_code VARCHAR/);
    expect(migration).toMatch(/latency_ms INTEGER NOT NULL/);
    expect(migration).toMatch(/consumed_at TIMESTAMPTZ/);
    expect(migration).toMatch(/request_hash CHAR\(64\) NOT NULL/);
  });
});
