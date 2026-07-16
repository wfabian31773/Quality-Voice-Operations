import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TENANT_DATA_CONTROL_CATALOG,
  TENANT_DATA_CONTROL_CATALOG_VERSION,
  validateTenantDataControlCatalog,
} from './tenantDataControlCatalog';

function migrationTenantTables(): string[] {
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
  const tables = new Set<string>();

  for (const file of files) {
    const lines = fs.readFileSync(path.join(migrationsDir, file), 'utf8').split(/\r?\n/);
    let table: string | null = null;
    let definition: string[] = [];
    for (const line of lines) {
      if (!table) {
        const rename = line.match(/^\s*ALTER TABLE\s+(?:public\.)?([a-zA-Z_][\w]*)\s+RENAME TO\s+([a-zA-Z_][\w]*)/i);
        if (rename && tables.has(rename[1])) {
          tables.delete(rename[1]);
          tables.add(rename[2]);
        }
      }
      const create = line.match(/^\s*CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-zA-Z_][\w]*)/i);
      if (create) {
        table = create[1];
        definition = [line];
        continue;
      }
      if (!table) continue;
      definition.push(line);
      if (/^\s*\);?\s*(?:--.*)?$/.test(line)) {
        if (/\btenant_id\b/i.test(definition.join('\n'))) tables.add(table);
        table = null;
        definition = [];
      }
    }
  }

  return [...tables].sort();
}

describe('tenant data-control catalog', () => {
  it('classifies every tenant-scoped table in ordered migrations with no stale entries', () => {
    const migrationTables = migrationTenantTables();
    const catalogTables = TENANT_DATA_CONTROL_CATALOG.map(({ table }) => table).sort();

    expect(migrationTables.length).toBeGreaterThan(180);
    expect(catalogTables).toEqual(migrationTables);
    expect(catalogTables).toContain('user_roles');
    expect(catalogTables).toContain('legacy_agent_prompt_versions');
    expect(catalogTables).not.toContain('user_tenant_roles');
  });

  it('is versioned, identifier-safe, unique, and classifies every entry', () => {
    expect(TENANT_DATA_CONTROL_CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(validateTenantDataControlCatalog()).toEqual([]);
    for (const entry of TENANT_DATA_CONTROL_CATALOG) {
      expect(entry.dataClasses.length).toBeGreaterThan(0);
      expect(entry.deletionDisposition).toMatch(/^(cascade|explicit_delete|controlled_audit_delete|preserve_evidence)$/);
    }
  });

  it('retains explicit high-risk classifications for healthcare data stores', () => {
    const byTable = new Map(TENANT_DATA_CONTROL_CATALOG.map((entry) => [entry.table, entry]));
    expect(byTable.get('call_transcripts')?.dataClasses).toContain('transcript');
    expect(byTable.get('tool_invocations')?.dataClasses).toContain('tool');
    expect(byTable.get('tickets')?.dataClasses).toContain('phi');
    expect(byTable.get('audit_logs')?.deletionDisposition).toBe('controlled_audit_delete');
    expect(byTable.get('tenant_deletion_requests')?.deletionDisposition).toBe('preserve_evidence');
  });

  it('reports unsafe, duplicate, and unclassified catalog entries for change control', () => {
    const invalid = [
      { table: 'Bad-Table', tenantColumn: 'tenant_id', dataClasses: [], deletionDisposition: 'cascade' },
      { table: 'duplicate', tenantColumn: 'tenant_id', dataClasses: ['tenant_data'], deletionDisposition: 'cascade' },
      { table: 'duplicate', tenantColumn: 'tenant_id', dataClasses: ['tenant_data'], deletionDisposition: 'cascade' },
    ] as never;
    expect(validateTenantDataControlCatalog(invalid)).toEqual([
      'unsafe table identifier: Bad-Table',
      'missing data classification: Bad-Table',
      'duplicate table: duplicate',
    ]);
  });
});
