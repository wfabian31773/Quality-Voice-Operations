import { describe, expect, it, vi } from 'vitest';
import { MIGRATION_ALIASES, reconcileMigrationAliases } from './migration-aliases';

describe('migration alias reconciliation', () => {
  it('defines the two proven branch-history aliases without treating target-only migrations as local files', () => {
    expect(MIGRATION_ALIASES.map(({ canonical, legacy }) => ({ canonical, legacy }))).toEqual([
      {
        canonical: '109_usage_metrics_details_column.sql',
        legacy: '111_usage_metrics_details_jsonb.sql',
      },
      {
        canonical: '113_tenants_industry_company_size.sql',
        legacy: '109_tenants_industry_company_size.sql',
      },
    ]);
    expect(JSON.stringify(MIGRATION_ALIASES)).not.toMatch(/widen_call_sessions|supabase_platform_rls_tester/i);
  });

  it('records the canonical filename only after the legacy record and equivalent schema are both proven', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ legacy_recorded: true, schema_equivalent: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ legacy_recorded: false, schema_equivalent: false }] });

    await reconcileMigrationAliases({ query });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][1]).toEqual(['111_usage_metrics_details_jsonb.sql']);
    expect(query.mock.calls[1][0]).toMatch(/INSERT INTO schema_migrations[\s\S]*ON CONFLICT \(filename\) DO NOTHING/i);
    expect(query.mock.calls[1][1]).toEqual(['109_usage_metrics_details_column.sql']);
    expect(query.mock.calls[2][1]).toEqual(['109_tenants_industry_company_size.sql']);
  });

  it('fails closed when a recorded legacy migration does not have the required final schema', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ legacy_recorded: true, schema_equivalent: false }],
    });

    await expect(reconcileMigrationAliases({ query })).rejects.toThrow(
      'Recorded migration alias failed schema verification',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
