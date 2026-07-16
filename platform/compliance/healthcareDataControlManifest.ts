import {
  TENANT_DATA_CONTROL_CATALOG,
  TENANT_DATA_CONTROL_CATALOG_VERSION,
  type TenantDataControlEntry,
  type TenantDeletionDisposition,
} from './tenantDataControlCatalog';

export const HEALTHCARE_DATA_CONTROL_MANIFEST_VERSION = TENANT_DATA_CONTROL_CATALOG_VERSION;
export type HealthcareDeletionDisposition = TenantDeletionDisposition;
export type HealthcareDataControlEntry = TenantDataControlEntry;
export const HEALTHCARE_DATA_CONTROL_MANIFEST: readonly HealthcareDataControlEntry[] = TENANT_DATA_CONTROL_CATALOG;

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export function validateHealthcareDataControlManifest(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of HEALTHCARE_DATA_CONTROL_MANIFEST) {
    if (!SAFE_IDENTIFIER.test(entry.table)) errors.push(`unsafe table identifier: ${entry.table}`);
    if (seen.has(entry.table)) errors.push(`duplicate table: ${entry.table}`);
    if (entry.dataClasses.length === 0) errors.push(`missing data classification: ${entry.table}`);
    seen.add(entry.table);
  }
  return errors;
}

export interface DiscoveredTenantTable {
  table: string;
  deleteRule: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | null;
}

export function buildTenantDeletionPlan(discovered: readonly DiscoveredTenantTable[]) {
  const manifest = new Map(HEALTHCARE_DATA_CONTROL_MANIFEST.map((entry) => [entry.table, entry]));
  const invalidIdentifiers: string[] = [];
  const unclassifiedTables: string[] = [];
  const cascadeTables: string[] = [];
  const explicitDeleteTables: string[] = [];
  const controlledAuditTables: string[] = [];
  const preservedEvidenceTables: string[] = [];

  for (const table of discovered) {
    if (!SAFE_IDENTIFIER.test(table.table)) {
      invalidIdentifiers.push(table.table);
      continue;
    }
    const entry = manifest.get(table.table);
    if (!entry) {
      unclassifiedTables.push(table.table);
      continue;
    }
    if (entry.deletionDisposition === 'preserve_evidence') preservedEvidenceTables.push(table.table);
    else if (entry.deletionDisposition === 'controlled_audit_delete') controlledAuditTables.push(table.table);
    else if (entry.deletionDisposition === 'explicit_delete' || table.deleteRule !== 'CASCADE') explicitDeleteTables.push(table.table);
    else cascadeTables.push(table.table);
  }

  return {
    manifestVersion: HEALTHCARE_DATA_CONTROL_MANIFEST_VERSION,
    ready: invalidIdentifiers.length === 0 && unclassifiedTables.length === 0,
    invalidIdentifiers: invalidIdentifiers.sort(),
    unclassifiedTables: unclassifiedTables.sort(),
    cascadeTables: cascadeTables.sort(),
    explicitDeleteTables: explicitDeleteTables.sort(),
    controlledAuditTables: controlledAuditTables.sort(),
    preservedEvidenceTables: preservedEvidenceTables.sort(),
  };
}
