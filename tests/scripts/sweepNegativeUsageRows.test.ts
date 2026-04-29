import { describe, it, expect, vi } from 'vitest';

import { runSweep } from '../../scripts/sweep-negative-usage-rows';

type QueryCall = { sql: string; params: unknown[] | undefined };

interface FakeRow {
  rows: unknown[];
}

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  calls: QueryCall[];
}

function makeClient(handler: (sql: string, params?: unknown[]) => FakeRow): FakeClient {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    return handler(sql, params);
  });
  // Cast to PoolClient — runSweep only uses .query.
  return { query, calls } as unknown as FakeClient;
}

function dailyResultFor(rows: unknown[]): FakeRow {
  return { rows };
}
function metricsResultFor(rows: unknown[]): FakeRow {
  return { rows };
}

function dispatch(
  sql: string,
  daily: unknown[],
  metrics: unknown[],
  existsByTenant: Map<string, boolean>,
  insertSink: Array<{ tenant: string; type: string; severity: string; message: string; metadata: unknown }>,
  params?: unknown[],
): FakeRow {
  if (sql.includes('FROM daily_org_usage')) return dailyResultFor(daily);
  if (sql.includes('FROM usage_metrics')) return metricsResultFor(metrics);
  if (sql.includes('FROM operations_alerts')) {
    const tenantId = String(params?.[0] ?? '');
    return { rows: [{ exists: existsByTenant.get(tenantId) ?? false }] };
  }
  if (sql.includes('INSERT INTO operations_alerts')) {
    const [tenant, type, severity, message, metadataJson] = params as [
      string,
      string,
      string,
      string,
      string,
    ];
    insertSink.push({
      tenant,
      type,
      severity,
      message,
      metadata: JSON.parse(metadataJson),
    });
    return { rows: [] };
  }
  return { rows: [] };
}

describe('sweep-negative-usage-rows', () => {
  it('returns no outcomes when both rollup tables are clean', async () => {
    const inserts: Array<{ tenant: string; type: string; severity: string; message: string; metadata: unknown }> = [];
    const existsMap = new Map<string, boolean>();

    const client = makeClient((sql, params) =>
      dispatch(sql, [], [], existsMap, inserts, params),
    );

    const result = await runSweep(client as unknown as never, {
      dryRun: false,
      tenantFilter: null,
    });

    expect(result.summaries).toEqual([]);
    expect(result.outcomes).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it('groups negative rows by tenant and opens one alert per tenant', async () => {
    const daily = [
      { tenant_id: 't-A', date: '2026-04-19', total_calls: -1, total_ai_minutes: -2, total_cost_cents: -17 },
      { tenant_id: 't-B', date: '2026-04-18', total_calls: 0, total_ai_minutes: 0, total_cost_cents: -50 },
    ];
    const metrics = [
      {
        tenant_id: 't-A',
        metric_type: 'calls_inbound',
        period_start: '2026-04-19T00:00:00Z',
        quantity: -1,
        total_cost_cents: -17,
      },
    ];
    const inserts: Array<{ tenant: string; type: string; severity: string; message: string; metadata: unknown }> = [];
    const existsMap = new Map<string, boolean>();

    const client = makeClient((sql, params) =>
      dispatch(sql, daily, metrics, existsMap, inserts, params),
    );

    const result = await runSweep(client as unknown as never, {
      dryRun: false,
      tenantFilter: null,
    });

    expect(result.summaries.map((s) => s.tenant_id)).toEqual(['t-A', 't-B']);
    expect(result.outcomes).toEqual([
      {
        tenant_id: 't-A',
        inserted: true,
        reason: 'inserted',
        daily_row_count: 1,
        usage_metric_row_count: 1,
      },
      {
        tenant_id: 't-B',
        inserted: true,
        reason: 'inserted',
        daily_row_count: 1,
        usage_metric_row_count: 0,
      },
    ]);

    expect(inserts).toHaveLength(2);
    expect(inserts[0].tenant).toBe('t-A');
    expect(inserts[0].type).toBe('billing_negative_usage_row_detected');
    expect(inserts[0].severity).toBe('warning');
    expect(inserts[0].message).toContain('Manual rebalance required');
    expect(inserts[0].message).toContain('docs/runbooks/billing-backfill-cross-day-rebalance.md');
    const meta0 = inserts[0].metadata as Record<string, unknown>;
    expect(meta0).toMatchObject({
      tenant_id: 't-A',
      manual_rebalance_required: true,
      runbook_url: 'docs/runbooks/billing-backfill-cross-day-rebalance.md',
      detection_source: 'scripts/sweep-negative-usage-rows.ts',
      daily_org_usage_negative_row_count: 1,
      usage_metrics_negative_row_count: 1,
      earliest_date: '2026-04-19',
      latest_date: '2026-04-19',
      sample_truncated: false,
    });
  });

  it('skips tenants that already have an unacknowledged alert open', async () => {
    const daily = [
      { tenant_id: 't-A', date: '2026-04-19', total_calls: -1, total_ai_minutes: 0, total_cost_cents: 0 },
    ];
    const inserts: Array<{ tenant: string; type: string; severity: string; message: string; metadata: unknown }> = [];
    const existsMap = new Map<string, boolean>([['t-A', true]]);

    const client = makeClient((sql, params) =>
      dispatch(sql, daily, [], existsMap, inserts, params),
    );

    const result = await runSweep(client as unknown as never, {
      dryRun: false,
      tenantFilter: null,
    });

    expect(result.outcomes).toEqual([
      {
        tenant_id: 't-A',
        inserted: false,
        reason: 'already_open',
        daily_row_count: 1,
        usage_metric_row_count: 0,
      },
    ]);
    expect(inserts).toEqual([]);
  });

  it('does not write any alerts in dry-run mode', async () => {
    const daily = [
      { tenant_id: 't-A', date: '2026-04-19', total_calls: -1, total_ai_minutes: 0, total_cost_cents: 0 },
    ];
    const inserts: Array<{ tenant: string; type: string; severity: string; message: string; metadata: unknown }> = [];
    const existsMap = new Map<string, boolean>();

    const client = makeClient((sql, params) =>
      dispatch(sql, daily, [], existsMap, inserts, params),
    );

    const result = await runSweep(client as unknown as never, {
      dryRun: true,
      tenantFilter: null,
    });

    expect(result.outcomes).toEqual([
      {
        tenant_id: 't-A',
        inserted: false,
        reason: 'skipped_dry_run',
        daily_row_count: 1,
        usage_metric_row_count: 0,
      },
    ]);
    expect(inserts).toEqual([]);
    // Importantly: no INSERT INTO operations_alerts should have been issued
    // and no SELECT against operations_alerts (the existence check) either,
    // since we short-circuit before either query in dry-run mode.
    const sqlSeen = (client.calls as QueryCall[]).map((c) => c.sql).join('\n');
    expect(sqlSeen).not.toMatch(/INSERT INTO operations_alerts/);
    expect(sqlSeen).not.toMatch(/FROM operations_alerts/);
  });

  it('passes the tenant filter into both rollup queries', async () => {
    const inserts: Array<{ tenant: string; type: string; severity: string; message: string; metadata: unknown }> = [];
    const existsMap = new Map<string, boolean>();

    const client = makeClient((sql, params) =>
      dispatch(sql, [], [], existsMap, inserts, params),
    );

    await runSweep(client as unknown as never, { dryRun: true, tenantFilter: 't-A' });

    const dailyCall = (client.calls as QueryCall[]).find((c) =>
      c.sql.includes('FROM daily_org_usage'),
    );
    const metricsCall = (client.calls as QueryCall[]).find((c) =>
      c.sql.includes('FROM usage_metrics'),
    );
    expect(dailyCall?.params).toEqual(['t-A']);
    expect(metricsCall?.params).toEqual(['t-A']);
    expect(dailyCall?.sql).toContain('tenant_id = $1');
    expect(metricsCall?.sql).toContain('tenant_id = $1');
  });

  it('caps the embedded sample at 25 rows and flags sample_truncated', async () => {
    const dailyMany = Array.from({ length: 30 }, (_, i) => ({
      tenant_id: 't-A',
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      total_calls: -1,
      total_ai_minutes: 0,
      total_cost_cents: 0,
    }));
    const inserts: Array<{ tenant: string; type: string; severity: string; message: string; metadata: unknown }> = [];
    const existsMap = new Map<string, boolean>();

    const client = makeClient((sql, params) =>
      dispatch(sql, dailyMany, [], existsMap, inserts, params),
    );

    await runSweep(client as unknown as never, { dryRun: false, tenantFilter: null });

    expect(inserts).toHaveLength(1);
    const meta = inserts[0].metadata as Record<string, unknown>;
    expect(meta.daily_org_usage_negative_row_count).toBe(30);
    expect(meta.sample_truncated).toBe(true);
    expect((meta.daily_org_usage_sample as unknown[]).length).toBe(25);
  });
});
