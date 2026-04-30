import { describe, it, expect, vi } from 'vitest';

import {
  runBackfill,
  runBackfillWithImmutabilityTrigger,
  IMMUTABILITY_TRIGGER_NAME,
} from '../../scripts/backfill-checkout-direction';

interface FakeRow {
  rows: unknown[];
  rowCount?: number;
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
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
  return { query, calls } as unknown as FakeClient;
}

function makeRow(id: string, changes: Record<string, unknown>) {
  return { id, changes };
}

describe('runBackfill (pure SELECT/UPDATE)', () => {
  it('classifies upgrade/downgrade/interval_change/new/same and groups updates by direction', async () => {
    const selectRows = [
      // Upgrade: starter monthly → pro monthly
      makeRow('u-1', {
        plan: 'pro',
        interval: 'monthly',
        fromPlan: 'starter',
        fromInterval: 'monthly',
        toPlan: 'pro',
        toInterval: 'monthly',
      }),
      // Downgrade: pro annual → starter annual
      makeRow('d-1', {
        plan: 'starter',
        interval: 'annual',
        fromPlan: 'pro',
        fromInterval: 'annual',
        toPlan: 'starter',
        toInterval: 'annual',
      }),
      // Interval change: pro monthly → pro annual
      makeRow('i-1', {
        plan: 'pro',
        interval: 'annual',
        fromPlan: 'pro',
        fromInterval: 'monthly',
        toPlan: 'pro',
        toInterval: 'annual',
      }),
      // New: no fromPlan recorded
      makeRow('n-1', {
        plan: 'starter',
        interval: 'monthly',
        toPlan: 'starter',
        toInterval: 'monthly',
      }),
      // Same: identical from/to (rare but recorded — must not crash)
      makeRow('s-1', {
        plan: 'pro',
        interval: 'monthly',
        fromPlan: 'pro',
        fromInterval: 'monthly',
        toPlan: 'pro',
        toInterval: 'monthly',
      }),
    ];

    const updates: QueryCall[] = [];
    const client = makeClient((sql, params) => {
      if (sql.includes('SELECT id, changes')) {
        return { rows: selectRows };
      }
      if (sql.includes('UPDATE audit_logs')) {
        updates.push({ sql, params });
        const ids = (params?.[0] as string[]) ?? [];
        return { rows: [], rowCount: ids.length };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await runBackfill(client as never, {
      dryRun: false,
      batchSize: 200,
    });

    expect(result.scanned).toBe(5);
    expect(result.skippedNoTarget).toBe(0);
    expect(result.classified).toEqual({
      upgrade: 1,
      downgrade: 1,
      interval_change: 1,
      same: 1,
      new: 1,
    });
    expect(result.updated).toBe(5);

    // One UPDATE per distinct derived direction.
    expect(updates).toHaveLength(5);
    const byDirection = new Map<string, string[]>();
    for (const call of updates) {
      const ids = call.params?.[0] as string[];
      const dir = call.params?.[1] as string;
      byDirection.set(dir, [...(byDirection.get(dir) ?? []), ...ids]);
    }
    expect(byDirection.get('upgrade')).toEqual(['u-1']);
    expect(byDirection.get('downgrade')).toEqual(['d-1']);
    expect(byDirection.get('interval_change')).toEqual(['i-1']);
    expect(byDirection.get('new')).toEqual(['n-1']);
    expect(byDirection.get('same')).toEqual(['s-1']);

    // Every UPDATE must re-assert the IS NULL guard so a concurrent
    // live writer between SELECT and UPDATE can't be clobbered.
    for (const call of updates) {
      expect(call.sql).toContain("changes->>'direction' IS NULL");
      expect(call.sql).toContain("action = 'billing.checkout_created'");
    }
  });

  it('falls back to plan/interval when toPlan/toInterval are missing', async () => {
    const selectRows = [
      makeRow('legacy-1', {
        plan: 'enterprise',
        interval: 'monthly',
        fromPlan: 'pro',
        fromInterval: 'monthly',
      }),
    ];
    const client = makeClient((sql, params) => {
      if (sql.includes('SELECT id, changes')) {
        return { rows: selectRows };
      }
      const ids = (params?.[0] as string[]) ?? [];
      return { rows: [], rowCount: ids.length };
    });

    const result = await runBackfill(client as never, {
      dryRun: false,
      batchSize: 200,
    });
    expect(result.classified.upgrade).toBe(1);
    expect(result.updated).toBe(1);
  });

  it('skips rows with no usable target plan/interval and leaves them alone', async () => {
    const selectRows = [
      // Garbage / pre-shape row — no plan info at all.
      makeRow('junk-1', { reason: 'something_else' }),
      // Unknown plan name (e.g. legacy "team" tier that no longer exists).
      makeRow('junk-2', { plan: 'team', interval: 'monthly' }),
    ];
    let updateCalls = 0;
    const client = makeClient((sql) => {
      if (sql.includes('SELECT id, changes')) {
        return { rows: selectRows };
      }
      updateCalls += 1;
      return { rows: [], rowCount: 0 };
    });

    const result = await runBackfill(client as never, {
      dryRun: false,
      batchSize: 200,
    });
    expect(result.scanned).toBe(2);
    expect(result.skippedNoTarget).toBe(2);
    expect(result.updated).toBe(0);
    expect(updateCalls).toBe(0);
  });

  it('issues no UPDATEs in dry-run mode but still classifies', async () => {
    const selectRows = [
      makeRow('u-1', {
        plan: 'pro',
        interval: 'monthly',
        fromPlan: 'starter',
        fromInterval: 'monthly',
      }),
    ];
    let updateCalls = 0;
    const client = makeClient((sql) => {
      if (sql.includes('SELECT id, changes')) {
        return { rows: selectRows };
      }
      updateCalls += 1;
      return { rows: [], rowCount: 0 };
    });

    const result = await runBackfill(client as never, {
      dryRun: true,
      batchSize: 200,
    });
    expect(result.classified.upgrade).toBe(1);
    expect(result.updated).toBe(0);
    expect(updateCalls).toBe(0);
  });

  it('chunks large id sets according to batchSize', async () => {
    // 5 upgrade rows, batchSize=2 → 3 UPDATEs (2, 2, 1).
    const selectRows = Array.from({ length: 5 }, (_, i) =>
      makeRow(`u-${i}`, {
        plan: 'pro',
        interval: 'monthly',
        fromPlan: 'starter',
        fromInterval: 'monthly',
      }),
    );
    const updates: QueryCall[] = [];
    const client = makeClient((sql, params) => {
      if (sql.includes('SELECT id, changes')) {
        return { rows: selectRows };
      }
      updates.push({ sql, params });
      const ids = (params?.[0] as string[]) ?? [];
      return { rows: [], rowCount: ids.length };
    });

    const result = await runBackfill(client as never, {
      dryRun: false,
      batchSize: 2,
    });
    expect(result.classified.upgrade).toBe(5);
    expect(result.updated).toBe(5);
    expect(updates).toHaveLength(3);
    expect((updates[0].params?.[0] as string[]).length).toBe(2);
    expect((updates[1].params?.[0] as string[]).length).toBe(2);
    expect((updates[2].params?.[0] as string[]).length).toBe(1);
  });

  it('is a no-op when no rows are missing direction (idempotent re-run)', async () => {
    let updateCalls = 0;
    const client = makeClient((sql) => {
      if (sql.includes('SELECT id, changes')) {
        return { rows: [] };
      }
      updateCalls += 1;
      return { rows: [], rowCount: 0 };
    });
    const result = await runBackfill(client as never, {
      dryRun: false,
      batchSize: 200,
    });
    expect(result.scanned).toBe(0);
    expect(result.updated).toBe(0);
    expect(updateCalls).toBe(0);
  });
});

describe('runBackfillWithImmutabilityTrigger (immutability dance)', () => {
  it('runs SELECT first, then DISABLE → UPDATE → ENABLE around the UPDATE phase only', async () => {
    const orderedSql: string[] = [];
    const client = makeClient((sql, params) => {
      orderedSql.push(sql);
      if (sql.includes('SELECT id, changes')) {
        return {
          rows: [
            makeRow('u-1', {
              plan: 'pro',
              interval: 'monthly',
              fromPlan: 'starter',
              fromInterval: 'monthly',
            }),
          ],
        };
      }
      if (sql.includes('UPDATE audit_logs')) {
        const ids = (params?.[0] as string[]) ?? [];
        return { rows: [], rowCount: ids.length };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await runBackfillWithImmutabilityTrigger(client as never, {
      dryRun: false,
      batchSize: 200,
    });
    expect(result.updated).toBe(1);

    const selectIdx = orderedSql.findIndex((s) => /SELECT id, changes/.test(s));
    const disableIdx = orderedSql.findIndex((s) => /DISABLE TRIGGER/.test(s));
    const updateIdx = orderedSql.findIndex((s) => /UPDATE audit_logs/.test(s));
    const enableIdx = orderedSql.findIndex((s) => /ENABLE TRIGGER/.test(s));
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(disableIdx).toBeGreaterThan(selectIdx);
    expect(updateIdx).toBeGreaterThan(disableIdx);
    expect(enableIdx).toBeGreaterThan(updateIdx);

    // The disable / enable must reference the immutability trigger by name,
    // never `USER` (which would also flip every other audit_logs trigger).
    expect(orderedSql[disableIdx]).toContain(IMMUTABILITY_TRIGGER_NAME);
    expect(orderedSql[disableIdx]).not.toMatch(/DISABLE TRIGGER USER\b/);
    expect(orderedSql[enableIdx]).toContain(IMMUTABILITY_TRIGGER_NAME);
  });

  it('skips the disable/enable dance entirely when classification finds nothing to update', async () => {
    // Avoid taking ACCESS EXCLUSIVE on audit_logs in the common
    // "already-backfilled" re-run: if the SELECT returns zero rows,
    // we must NOT issue ALTER TABLE at all.
    const orderedSql: string[] = [];
    const client = makeClient((sql) => {
      orderedSql.push(sql);
      if (sql.includes('SELECT id, changes')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });

    const result = await runBackfillWithImmutabilityTrigger(client as never, {
      dryRun: false,
      batchSize: 200,
    });
    expect(result.scanned).toBe(0);
    expect(result.updated).toBe(0);
    expect(orderedSql.some((s) => /DISABLE TRIGGER/.test(s))).toBe(false);
    expect(orderedSql.some((s) => /ENABLE TRIGGER/.test(s))).toBe(false);
  });

  it('skips the disable/enable dance when every candidate row is unclassifiable', async () => {
    // Same lock-discipline guarantee as above, but for the case where
    // we found rows but couldn't derive a direction for any of them.
    const orderedSql: string[] = [];
    const client = makeClient((sql) => {
      orderedSql.push(sql);
      if (sql.includes('SELECT id, changes')) {
        return {
          rows: [
            makeRow('junk-1', { reason: 'something_else' }),
            makeRow('junk-2', { plan: 'team', interval: 'monthly' }),
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await runBackfillWithImmutabilityTrigger(client as never, {
      dryRun: false,
      batchSize: 200,
    });
    expect(result.scanned).toBe(2);
    expect(result.skippedNoTarget).toBe(2);
    expect(result.updated).toBe(0);
    expect(orderedSql.some((s) => /DISABLE TRIGGER/.test(s))).toBe(false);
    expect(orderedSql.some((s) => /ENABLE TRIGGER/.test(s))).toBe(false);
  });

  it('re-enables the trigger even if the inner UPDATE throws', async () => {
    const orderedSql: string[] = [];
    const client = makeClient((sql) => {
      orderedSql.push(sql);
      if (sql.includes('SELECT id, changes')) {
        return {
          rows: [
            makeRow('u-1', {
              plan: 'pro',
              interval: 'monthly',
              fromPlan: 'starter',
              fromInterval: 'monthly',
            }),
          ],
        };
      }
      if (sql.includes('UPDATE audit_logs')) {
        throw new Error('simulated lock timeout');
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(
      runBackfillWithImmutabilityTrigger(client as never, {
        dryRun: false,
        batchSize: 200,
      }),
    ).rejects.toThrow('simulated lock timeout');

    const enableSeen = orderedSql.some((s) => /ENABLE TRIGGER/.test(s));
    expect(enableSeen).toBe(true);
  });

  it('skips the disable/enable dance entirely in dry-run mode (no lock taken)', async () => {
    const orderedSql: string[] = [];
    const client = makeClient((sql) => {
      orderedSql.push(sql);
      if (sql.includes('SELECT id, changes')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    await runBackfillWithImmutabilityTrigger(client as never, {
      dryRun: true,
      batchSize: 200,
    });
    expect(orderedSql.some((s) => /DISABLE TRIGGER/.test(s))).toBe(false);
    expect(orderedSql.some((s) => /ENABLE TRIGGER/.test(s))).toBe(false);
  });
});

