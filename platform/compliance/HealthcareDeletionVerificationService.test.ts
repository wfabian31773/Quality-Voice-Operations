import { describe, expect, it, vi } from 'vitest';
import {
  discoverTenantScopedTables,
  executeExplicitTenantDeletes,
  verifyTenantRowsRemoved,
} from './HealthcareDeletionVerificationService';

describe('healthcare deletion verification service', () => {
  it('discovers every public tenant_id table and its tenant FK delete rule', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ table_name: 'call_sessions', delete_rule: 'CASCADE' }] });
    await expect(discoverTenantScopedTables({ query })).resolves.toEqual([
      { table: 'call_sessions', deleteRule: 'CASCADE' },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(
      /pg_class[\s\S]*relkind[\s\S]*pg_inherits[\s\S]*referential_constraints/,
    ));
    expect(String(query.mock.calls[0]?.[0])).not.toMatch(/information_schema\.columns c/);
  });

  it('maps a tenant table without a foreign-key delete rule to null', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ table_name: 'orphan_store', delete_rule: null }] });
    await expect(discoverTenantScopedTables({ query })).resolves.toEqual([
      { table: 'orphan_store', deleteRule: null },
    ]);
  });

  it('returns one root relation and chooses a non-cascade rule when multiple tenant FK paths exist', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { table_name: 'multi_path_store', delete_rule: 'CASCADE' },
      { table_name: 'multi_path_store', delete_rule: 'NO ACTION' },
      { table_name: 'multi_path_store', delete_rule: 'CASCADE' },
    ] });

    await expect(discoverTenantScopedTables({ query })).resolves.toEqual([
      { table: 'multi_path_store', deleteRule: 'NO ACTION' },
    ]);
    expect(String(query.mock.calls[0]?.[0])).toMatch(/GROUP BY c\.table_name/i);
  });

  it('refuses unclassified schema drift before issuing a delete', async () => {
    const query = vi.fn();
    await expect(executeExplicitTenantDeletes(
      { query },
      'tenant-1',
      {
        manifestVersion: '1.0.0', ready: false, invalidIdentifiers: [],
        unclassifiedTables: ['new_phi_store'], cascadeTables: [], explicitDeleteTables: [],
        controlledAuditTables: [], preservedEvidenceTables: [],
      },
    )).rejects.toThrow(/unclassified tenant data stores/i);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { invalidIdentifiers: ['unsafe-name'], unclassifiedTables: [] },
    { invalidIdentifiers: [], unclassifiedTables: ['new_phi_store'] },
  ])('refuses a nominally ready plan when a safety list is non-empty', async (safetyGap) => {
    const query = vi.fn();
    await expect(executeExplicitTenantDeletes(
      { query },
      'tenant-1',
      {
        manifestVersion: '1.0.0', ready: true,
        invalidIdentifiers: safetyGap.invalidIdentifiers,
        unclassifiedTables: safetyGap.unclassifiedTables,
        cascadeTables: [], explicitDeleteTables: [], controlledAuditTables: [], preservedEvidenceTables: [],
      },
    )).rejects.toThrow(/unsafe or unclassified/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('deletes only manifest-approved explicit tables with parameterized tenant values', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });
    await executeExplicitTenantDeletes(
      { query },
      'tenant-1',
      {
        manifestVersion: '1.0.0', ready: true, invalidIdentifiers: [], unclassifiedTables: [],
        cascadeTables: ['call_sessions'], explicitDeleteTables: ['error_logs', 'escalation_tasks'],
        controlledAuditTables: ['audit_logs'], preservedEvidenceTables: ['tenant_deletion_requests'],
      },
    );
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toMatch(/^DELETE FROM "(?:error_logs|escalation_tasks)" WHERE "tenant_id"::text = \$1$/);
      expect(values).toEqual(['tenant-1']);
    }
  });

  it('reports remaining rows without selecting or returning PHI values', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => ({
      rows: [{ count: sql.includes('call_sessions') ? '0' : '2' }],
    }));
    const result = await verifyTenantRowsRemoved({ query }, 'tenant-1', ['call_sessions', 'escalation_tasks']);
    expect(result).toEqual({ verified: false, remaining: [{ table: 'escalation_tasks', count: 2 }] });
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/SELECT \*/i);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toContain('"tenant_id"::text = $1');
      expect(values).toEqual(['tenant-1']);
    }
  });

  it('deduplicates verification tables and treats a missing count row as zero', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(verifyTenantRowsRemoved(
      { query }, 'tenant-1', ['call_sessions', 'call_sessions'],
    )).resolves.toEqual({ verified: true, remaining: [] });
    expect(query).toHaveBeenCalledOnce();
  });

  it('rejects an unsafe discovered identifier before interpolating it into SQL', async () => {
    const query = vi.fn();
    await expect(verifyTenantRowsRemoved(
      { query }, 'tenant-1', ['call_sessions; DROP TABLE tenants'],
    )).rejects.toThrow(/unsafe database identifier/i);
    expect(query).not.toHaveBeenCalled();
  });
});
