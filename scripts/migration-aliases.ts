interface MigrationAliasClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

interface MigrationAlias {
  canonical: string;
  legacy: string;
  schemaVerificationSql: string;
}

export const MIGRATION_ALIASES: readonly MigrationAlias[] = [
  {
    canonical: '109_usage_metrics_details_column.sql',
    legacy: '111_usage_metrics_details_jsonb.sql',
    schemaVerificationSql: `EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'usage_metrics'
         AND column_name = 'details'
         AND data_type = 'jsonb'
    )`,
  },
  {
    canonical: '113_tenants_industry_company_size.sql',
    legacy: '109_tenants_industry_company_size.sql',
    schemaVerificationSql: `EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'tenants'
         AND column_name = 'industry'
         AND data_type = 'character varying'
         AND character_maximum_length = 64
         AND is_nullable = 'NO'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'tenants'
         AND column_name = 'company_size'
         AND data_type = 'character varying'
         AND character_maximum_length = 32
         AND is_nullable = 'NO'
    )`,
  },
] as const;

export async function reconcileMigrationAliases(client: MigrationAliasClient): Promise<void> {
  for (const alias of MIGRATION_ALIASES) {
    const result = await client.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM schema_migrations WHERE filename = $1
         ) AS legacy_recorded,
         (${alias.schemaVerificationSql}) AS schema_equivalent`,
      [alias.legacy],
    );
    const legacyRecorded = result.rows[0]?.legacy_recorded === true;
    const schemaEquivalent = result.rows[0]?.schema_equivalent === true;
    if (!legacyRecorded) continue;
    if (!schemaEquivalent) {
      throw new Error(
        `Recorded migration alias failed schema verification: ${alias.legacy}`,
      );
    }
    await client.query(
      `INSERT INTO schema_migrations (filename)
       VALUES ($1)
       ON CONFLICT (filename) DO NOTHING`,
      [alias.canonical],
    );
  }
}
