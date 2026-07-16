import { describe, expect, it } from 'vitest';
import {
  HEALTHCARE_DATA_CONTROL_MANIFEST,
  HEALTHCARE_DATA_CONTROL_MANIFEST_VERSION,
  buildTenantDeletionPlan,
  validateHealthcareDataControlManifest,
} from './healthcareDataControlManifest';

describe('healthcare data control manifest', () => {
  it('accounts for every known PHI-capable first-party store', () => {
    expect(HEALTHCARE_DATA_CONTROL_MANIFEST_VERSION).toBe('3.0.0');
    expect(HEALTHCARE_DATA_CONTROL_MANIFEST.length).toBeGreaterThan(180);
    expect(HEALTHCARE_DATA_CONTROL_MANIFEST.map(({ table }) => table)).toEqual(expect.arrayContaining([
      'call_sessions', 'call_events', 'call_transcripts', 'tool_invocations',
      'outbox_messages', 'tickets', 'escalation_tasks', 'tool_failure_events',
      'knowledge_articles', 'error_logs', 'audit_logs', 'tenant_deletion_requests',
      'user_roles', 'legacy_agent_prompt_versions',
    ]));
    expect(HEALTHCARE_DATA_CONTROL_MANIFEST.map(({ table }) => table)).not.toContain('user_tenant_roles');
    expect(validateHealthcareDataControlManifest()).toEqual([]);
  });

  it('classifies non-healthcare tenant stores so verified deletion can cover the whole tenant', () => {
    const plan = buildTenantDeletionPlan([
      { table: 'billing_events', deleteRule: 'CASCADE' },
      { table: 'crm_caller_identities', deleteRule: null },
    ]);
    expect(plan).toMatchObject({
      ready: true,
      cascadeTables: ['billing_events'],
      explicitDeleteTables: ['crm_caller_identities'],
      unclassifiedTables: [],
    });
  });

  it('covers newly discovered tenant tables instead of silently ignoring schema drift', () => {
    const plan = buildTenantDeletionPlan([
      { table: 'call_sessions', deleteRule: 'CASCADE' },
      { table: 'escalation_tasks', deleteRule: null },
      { table: 'new_phi_store', deleteRule: null },
      { table: 'tenant_deletion_requests', deleteRule: 'SET NULL' },
    ]);
    expect(plan.cascadeTables).toContain('call_sessions');
    expect(plan.explicitDeleteTables).toContain('escalation_tasks');
    expect(plan.preservedEvidenceTables).toContain('tenant_deletion_requests');
    expect(plan.unclassifiedTables).toEqual(['new_phi_store']);
    expect(plan.ready).toBe(false);
  });

  it('rejects unsafe or duplicate database identifiers', () => {
    expect(buildTenantDeletionPlan([{ table: 'tickets; DROP TABLE tenants', deleteRule: null }])).toMatchObject({
      ready: false,
      invalidIdentifiers: ['tickets; DROP TABLE tenants'],
    });
  });
});
