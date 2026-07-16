import type { DiscoveredTenantTable } from './healthcareDataControlManifest';

interface DeletionClient {
  query: (sql: string, values?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount?: number | null;
  }>;
}

interface TenantDeletionPlan {
  manifestVersion: string;
  ready: boolean;
  invalidIdentifiers: string[];
  unclassifiedTables: string[];
  cascadeTables: string[];
  explicitDeleteTables: string[];
  controlledAuditTables: string[];
  preservedEvidenceTables: string[];
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const DELETE_RULE_PRIORITY = new Map<DiscoveredTenantTable['deleteRule'], number>([
  ['CASCADE', 0],
  ['SET NULL', 1],
  ['RESTRICT', 2],
  ['NO ACTION', 3],
  [null, 4],
]);

function quoteIdentifier(identifier: string): string {
  if (!SAFE_IDENTIFIER.test(identifier)) throw new Error(`Unsafe database identifier: ${identifier}`);
  return `"${identifier}"`;
}

export async function discoverTenantScopedTables(
  client: DeletionClient,
): Promise<DiscoveredTenantTable[]> {
  const { rows } = await client.query(
    `WITH root_tenant_relations AS (
       SELECT n.nspname AS table_schema, c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (
            SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid
          )
          AND EXISTS (
            SELECT 1
              FROM pg_attribute a
             WHERE a.attrelid = c.oid
               AND a.attname = 'tenant_id'
               AND a.attnum > 0
               AND NOT a.attisdropped
          )
     )
     SELECT c.table_name,
            CASE
              WHEN COUNT(rc.delete_rule) = 0 THEN NULL
              WHEN BOOL_AND(rc.delete_rule = 'CASCADE') THEN 'CASCADE'
              WHEN BOOL_OR(rc.delete_rule = 'NO ACTION') THEN 'NO ACTION'
              WHEN BOOL_OR(rc.delete_rule = 'RESTRICT') THEN 'RESTRICT'
              WHEN BOOL_OR(rc.delete_rule = 'SET NULL') THEN 'SET NULL'
              ELSE NULL
            END AS delete_rule
       FROM root_tenant_relations c
       LEFT JOIN information_schema.key_column_usage kcu
         ON kcu.table_schema = c.table_schema
        AND kcu.table_name = c.table_name
        AND kcu.column_name = 'tenant_id'
       LEFT JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = kcu.constraint_schema
        AND rc.constraint_name = kcu.constraint_name
      GROUP BY c.table_name
      ORDER BY c.table_name`,
  );
  const discovered = new Map<string, DiscoveredTenantTable['deleteRule']>();
  for (const row of rows) {
    const table = String(row.table_name);
    const candidate = row.delete_rule
      ? String(row.delete_rule).toUpperCase() as DiscoveredTenantTable['deleteRule']
      : null;
    if (!DELETE_RULE_PRIORITY.has(candidate)) {
      discovered.set(table, null);
      continue;
    }
    const current = discovered.get(table);
    if (!discovered.has(table) || (DELETE_RULE_PRIORITY.get(candidate) ?? 4) > (DELETE_RULE_PRIORITY.get(current ?? null) ?? 4)) {
      discovered.set(table, candidate);
    }
  }
  return [...discovered.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([table, deleteRule]) => ({ table, deleteRule }));
}

export async function executeExplicitTenantDeletes(
  client: DeletionClient,
  tenantId: string,
  plan: TenantDeletionPlan,
): Promise<void> {
  if (!plan.ready || plan.invalidIdentifiers.length > 0 || plan.unclassifiedTables.length > 0) {
    throw new Error('Refusing tenant deletion with unsafe or unclassified tenant data stores');
  }
  for (const table of [...plan.explicitDeleteTables].sort()) {
    await client.query(
      `DELETE FROM ${quoteIdentifier(table)} WHERE "tenant_id"::text = $1`,
      [tenantId],
    );
  }
}

export async function verifyTenantRowsRemoved(
  client: DeletionClient,
  tenantId: string,
  tables: readonly string[],
): Promise<{ verified: boolean; remaining: Array<{ table: string; count: number }> }> {
  const remaining: Array<{ table: string; count: number }> = [];
  for (const table of [...new Set(tables)].sort()) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table)} WHERE "tenant_id"::text = $1`,
      [tenantId],
    );
    const count = Number(rows[0]?.count ?? 0);
    if (count > 0) remaining.push({ table, count });
  }
  return { verified: remaining.length === 0, remaining };
}
