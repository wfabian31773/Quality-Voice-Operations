import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'migrations/117_tenant_rls_remediation.sql'),
  'utf8',
);
const preflight = readFileSync(
  join(process.cwd(), 'platform/compliance/HealthcareDataControlPreflight.ts'),
  'utf8',
);

const VARCHAR_TENANT_TABLES = [
  'activation_events',
  'case_studies',
  'connector_alert_mutes',
  'connector_alert_recipients',
  'connector_alert_settings',
  'connector_stale_alerts',
  'crm_stale_cache_scrubs',
  'distributed_locks',
  'evolution_signals',
  'gin_policy_acceptance_records',
  'milestone_thresholds',
  'operations_alerts',
  'push_delivery_attempts',
  'support_recipient_bounce_alerts',
  'support_tickets',
  'tenant_deletion_requests',
  'tenant_notifications',
  'user_devices',
  'verified_caller_alert_recipients',
  'widget_configs',
  'widget_tokens',
] as const;

const UUID_TENANT_TABLES = [
  'marketplace_purchases',
  'marketplace_reviews',
] as const;

const ALL_REMEDIATED_TABLES = [...VARCHAR_TENANT_TABLES, ...UUID_TENANT_TABLES];

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('tenant RLS remediation migration', () => {
  it('enables and forces RLS on every audited root tenant relation', () => {
    expect(ALL_REMEDIATED_TABLES).toHaveLength(23);

    for (const table of ALL_REMEDIATED_TABLES) {
      const name = escaped(table);
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`, 'i'));
    }
  });

  it('creates fail-closed read/write tenant policies for varchar tenant keys', () => {
    for (const table of VARCHAR_TENANT_TABLES) {
      const name = escaped(table);
      expect(migration).toMatch(new RegExp(
        `CREATE POLICY tenant_isolation_${name}[\\s\\S]*ON ${name}[\\s\\S]*FOR ALL[\\s\\S]*USING \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', TRUE\\), ''\\)::varchar\\)[\\s\\S]*WITH CHECK \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', TRUE\\), ''\\)::varchar\\)`,
        'i',
      ));
    }
  });

  it('uses an explicit uuid cast for marketplace tenant keys', () => {
    for (const table of UUID_TENANT_TABLES) {
      const name = escaped(table);
      expect(migration).toMatch(new RegExp(
        `CREATE POLICY tenant_isolation_${name}[\\s\\S]*ON ${name}[\\s\\S]*FOR ALL[\\s\\S]*USING \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', TRUE\\), ''\\)::uuid\\)[\\s\\S]*WITH CHECK \\(tenant_id = NULLIF\\(current_setting\\('app\\.tenant_id', TRUE\\), ''\\)::uuid\\)`,
        'i',
      ));
    }
  });

  it('is idempotent and never grants an unscoped or null-tenant bypass', () => {
    for (const table of ALL_REMEDIATED_TABLES) {
      expect(migration).toMatch(new RegExp(
        `DROP POLICY IF EXISTS tenant_isolation_${escaped(table)} ON ${escaped(table)}`,
        'i',
      ));
    }
    expect(migration).not.toMatch(/USING\s*\(\s*TRUE\s*\)/i);
    expect(migration).not.toMatch(/tenant_id\s+IS\s+NULL\s+OR/i);
  });

  it('makes the remediation migration an explicit readiness prerequisite', () => {
    expect(preflight).toContain("'117_tenant_rls_remediation.sql'");
  });
});
