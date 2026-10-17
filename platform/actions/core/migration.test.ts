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

  it('makes action_audit_log append-only with INSERT/SELECT grants and mutation triggers', () => {
    expect(migration).toMatch(/GRANT SELECT, INSERT ON action_audit_log TO qvo_app/);
    expect(migration).toMatch(/REVOKE UPDATE, DELETE ON action_audit_log FROM qvo_app/);
    expect(migration).toMatch(/GRANT SELECT, INSERT ON action_audit_log TO platform_rls_tester/);
    expect(migration).toMatch(/REVOKE UPDATE, DELETE ON action_audit_log FROM platform_rls_tester/);
    expect(migration).not.toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON action_idempotency, action_proposals, action_audit_log/,
    );
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION prevent_action_audit_log_mutation\(\)/);
    expect(migration).toMatch(/CREATE TRIGGER action_audit_log_no_update BEFORE UPDATE ON action_audit_log/);
    expect(migration).toMatch(/CREATE TRIGGER action_audit_log_no_delete BEFORE DELETE ON action_audit_log/);
    expect(migration).toMatch(/action_audit_log is immutable/);
  });
});
