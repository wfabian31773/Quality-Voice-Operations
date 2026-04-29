/**
 * Behavior tests for `scripts/backfill-dispatch-job-geocodes.ts`.
 *
 * The dispatch-job geocode backfill is the operational tool that warms
 * `dispatch_jobs.address_lat` / `address_lon` for both the dispatcher
 * live map and the route-replay endpoint. Several knobs only show up
 * during incident-time runs (idempotency, `--actionable-only`, the
 * deprecated `--include-all-statuses` no-op, dry-run, per-tenant tally,
 * concurrent-edit-safe UPDATE), so these tests pin the contract:
 *
 *   1. parseArgs accepts the documented flags AND the deprecated alias
 *      as a no-op (legacy runbooks must keep working).
 *   2. selectCandidates default scope walks ALL statuses; the
 *      `--actionable-only` switch narrows to still-open jobs.
 *   3. selectCandidates skips rows where the cached coords are already
 *      fresh for the *current* address — i.e. the script is idempotent.
 *   4. persistCoords is idempotent and concurrent-edit-safe: a row whose
 *      address was edited between SELECT and UPDATE is left untouched.
 *   5. runBackfill in dry-run mode performs zero UPDATEs.
 *   6. runBackfill's per-tenant tallies sum back to the totals and
 *      `scanned` matches the candidate-set size, so an operator can
 *      trust the on-screen numbers during an incident.
 *
 * The DB layer is a real Postgres engine via `pg-mem` so the SQL in the
 * script is exercised exactly as it ships, not mocked through a stub
 * client.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, DataType, type IMemoryDb } from 'pg-mem';
import type { PoolClient } from 'pg';

import {
  parseArgs,
  selectCandidates,
  persistCoords,
  runBackfill,
  defaultRpsFor,
  getRpsCap,
  maskAddress,
  ACTIONABLE_STATUSES,
  type CliOptions,
} from '../../scripts/backfill-dispatch-job-geocodes';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function makeOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    dryRun: false,
    actionableOnly: false,
    tenantId: null,
    limit: null,
    rps: null,
    ...overrides,
  };
}

interface DbHandles {
  mem: IMemoryDb;
  client: PoolClient;
  end: () => Promise<void>;
}

/**
 * pg-mem (3.x) doesn't yet implement the SQL standard `IS DISTINCT FROM`
 * predicate. Production runs against real Postgres where it works
 * natively. To keep the script's SQL exactly as it ships *and* still
 * exercise it under pg-mem, we transparently rewrite the predicate at
 * the client boundary into the boolean equivalent. If pg-mem ever
 * grows native support, the rewrite becomes a no-op.
 *
 * Limited to the simple `<ident-or-param> IS DISTINCT FROM <ident-or-param>`
 * shape the backfill actually uses — we do NOT try to be a general
 * SQL transpiler.
 */
function rewriteSqlForPgMem(sql: string): string {
  return sql.replace(
    /(\$?\w+(?:\.\w+)?)\s+IS\s+DISTINCT\s+FROM\s+(\$?\w+(?:\.\w+)?)/gi,
    (_m, a, b) =>
      `((${a}) IS NULL AND (${b}) IS NOT NULL OR (${a}) IS NOT NULL AND (${b}) IS NULL OR (${a}) <> (${b}))`,
  );
}

function wrapClientForPgMem(client: PoolClient): PoolClient {
  const handler: ProxyHandler<PoolClient> = {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (sqlOrConfig: unknown, params?: unknown[]) => {
          if (typeof sqlOrConfig === 'string') {
            return (target as { query: Function }).query(rewriteSqlForPgMem(sqlOrConfig), params);
          }
          const cfg = sqlOrConfig as { text: string };
          return (target as { query: Function }).query({
            ...(cfg as object),
            text: rewriteSqlForPgMem(cfg.text),
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  };
  return new Proxy(client, handler);
}

async function makeDb(): Promise<DbHandles> {
  const mem = newDb();
  // pg-mem 3.x doesn't ship a `btrim` builtin (Postgres has it natively
  // and the script uses it as part of "address is non-empty"). Register
  // the standard semantics so the script's WHERE clause works as-is.
  mem.public.registerFunction({
    name: 'btrim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (s: string | null) => (s == null ? null : s.trim()),
  });

  // Replicate the schema shape used by the script. We mirror the pieces
  // of `dispatch_jobs` the backfill touches plus a `status` column for
  // the `--actionable-only` filter. NUMERIC(10,7) matches migration 087.
  mem.public.none(`
    CREATE TABLE dispatch_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      address TEXT,
      address_lat NUMERIC(10, 7),
      address_lon NUMERIC(10, 7),
      address_geocoded_at TIMESTAMPTZ,
      address_geocoded_for TEXT
    );
  `);
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const rawClient: PoolClient = await pool.connect();
  const client = wrapClientForPgMem(rawClient);
  return {
    mem,
    client,
    async end() {
      rawClient.release();
      await pool.end();
    },
  };
}

interface SeedRow {
  id: string;
  tenant_id: string;
  status?: string;
  address?: string | null;
  address_lat?: number | null;
  address_lon?: number | null;
  address_geocoded_for?: string | null;
}

async function seed(client: PoolClient, rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    await client.query(
      `INSERT INTO dispatch_jobs
        (id, tenant_id, status, address, address_lat, address_lon, address_geocoded_for, address_geocoded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 IS NULL THEN NULL ELSE NOW() END)`,
      [
        r.id,
        r.tenant_id,
        r.status ?? 'pending',
        r.address ?? null,
        r.address_lat ?? null,
        r.address_lon ?? null,
        r.address_geocoded_for ?? null,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('returns documented defaults when no flags are passed', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      actionableOnly: false,
      tenantId: null,
      limit: null,
      rps: null,
    });
  });

  it('parses --dry-run, --actionable-only, --tenant=, --limit=, --rps= together', () => {
    const opts = parseArgs([
      '--dry-run',
      '--actionable-only',
      '--tenant=acme',
      '--limit=50',
      '--rps=2.5',
    ]);
    expect(opts).toEqual({
      dryRun: true,
      actionableOnly: true,
      tenantId: 'acme',
      limit: 50,
      rps: 2.5,
    });
  });

  it('accepts the deprecated --include-all-statuses alias as a silent no-op', () => {
    // Legacy runbooks and any cron entries that still pass the old flag
    // must continue to work. The flag must NOT flip --actionable-only,
    // and it must NOT cause parseArgs to throw.
    const opts = parseArgs(['--include-all-statuses']);
    expect(opts).toEqual({
      dryRun: false,
      actionableOnly: false,
      tenantId: null,
      limit: null,
      rps: null,
    });
  });

  it('--include-all-statuses combined with --actionable-only does not undo --actionable-only', () => {
    // The whole point of the alias being a no-op is that operators can
    // leave it in their cron line while ALSO narrowing scope. If the
    // flag accidentally toggled scope back, the narrower run would be
    // invisibly broadened.
    const opts = parseArgs(['--include-all-statuses', '--actionable-only']);
    expect(opts.actionableOnly).toBe(true);
  });

  it('ignores garbage values for --limit and --rps rather than crashing', () => {
    const opts = parseArgs(['--limit=not-a-number', '--rps=-3']);
    expect(opts.limit).toBeNull();
    expect(opts.rps).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rate-limit helpers (pure)
// ---------------------------------------------------------------------------

describe('rate-limit helpers', () => {
  it('defaults Nominatim to 1 rps per OSM policy and other providers to their published headroom', () => {
    expect(defaultRpsFor('nominatim')).toBe(1);
    expect(defaultRpsFor('mapbox')).toBe(5);
    expect(defaultRpsFor('google')).toBe(10);
    expect(defaultRpsFor('none')).toBe(1);
  });

  it('getRpsCap honors the explicit --rps override above env and provider defaults', () => {
    const prev = process.env.DISPATCH_GEOCODE_BACKFILL_RPS;
    process.env.DISPATCH_GEOCODE_BACKFILL_RPS = '4';
    try {
      expect(getRpsCap('nominatim', 7)).toBe(7);
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_GEOCODE_BACKFILL_RPS;
      else process.env.DISPATCH_GEOCODE_BACKFILL_RPS = prev;
    }
  });

  it('getRpsCap falls back to env var when no override is provided', () => {
    const prev = process.env.DISPATCH_GEOCODE_BACKFILL_RPS;
    process.env.DISPATCH_GEOCODE_BACKFILL_RPS = '3';
    try {
      expect(getRpsCap('nominatim', null)).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_GEOCODE_BACKFILL_RPS;
      else process.env.DISPATCH_GEOCODE_BACKFILL_RPS = prev;
    }
  });

  it('getRpsCap falls back to provider default when neither override nor env is set', () => {
    const prev = process.env.DISPATCH_GEOCODE_BACKFILL_RPS;
    delete process.env.DISPATCH_GEOCODE_BACKFILL_RPS;
    try {
      expect(getRpsCap('mapbox', null)).toBe(5);
    } finally {
      if (prev !== undefined) process.env.DISPATCH_GEOCODE_BACKFILL_RPS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// maskAddress
// ---------------------------------------------------------------------------

describe('maskAddress', () => {
  it('emits a non-reversible fingerprint that omits the full address', () => {
    const masked = maskAddress('123 Main Street, Springfield');
    expect(masked).not.toContain('Main Street');
    expect(masked).toContain('123 ');
    expect(masked).toContain('len=28');
  });

  it("returns '<empty>' for an all-whitespace address", () => {
    expect(maskAddress('   ')).toBe('<empty>');
  });
});

// ---------------------------------------------------------------------------
// selectCandidates
// ---------------------------------------------------------------------------

describe('selectCandidates', () => {
  let db: DbHandles;
  beforeEach(async () => {
    db = await makeDb();
  });

  it('default scope returns rows missing coords across ALL statuses (open AND historical)', async () => {
    // The route-replay endpoint pre-populates historical jobs, so the
    // default MUST include completed/cancelled. If a future refactor
    // drops them, route-replay will silently regress.
    await seed(db.client, [
      { id: 'j-pending', tenant_id: 't1', status: 'pending', address: '1 Main St' },
      { id: 'j-done', tenant_id: 't1', status: 'completed', address: '2 Elm St' },
      { id: 'j-cancel', tenant_id: 't1', status: 'cancelled', address: '3 Oak St' },
      { id: 'j-enroute', tenant_id: 't1', status: 'en_route', address: '4 Pine St' },
    ]);

    const rows = await selectCandidates(db.client, makeOpts());
    expect(rows.map((r) => r.id).sort()).toEqual([
      'j-cancel',
      'j-done',
      'j-enroute',
      'j-pending',
    ]);
    await db.end();
  });

  it('--actionable-only scope filters to the documented open statuses', async () => {
    // Sanity-check the canonical list itself so a future renaming of a
    // status (e.g. "in_progress" -> "working") doesn't silently
    // exclude live jobs.
    expect(ACTIONABLE_STATUSES).toEqual([
      'pending',
      'assigned',
      'scheduled',
      'en_route',
      'on_site',
      'in_progress',
    ]);

    await seed(db.client, [
      { id: 'j-pending', tenant_id: 't1', status: 'pending', address: '1 Main St' },
      { id: 'j-assigned', tenant_id: 't1', status: 'assigned', address: '2 Elm St' },
      { id: 'j-done', tenant_id: 't1', status: 'completed', address: '3 Oak St' },
      { id: 'j-cancel', tenant_id: 't1', status: 'cancelled', address: '4 Pine St' },
      { id: 'j-progress', tenant_id: 't1', status: 'in_progress', address: '5 Birch St' },
    ]);

    const rows = await selectCandidates(db.client, makeOpts({ actionableOnly: true }));
    expect(rows.map((r) => r.id).sort()).toEqual([
      'j-assigned',
      'j-pending',
      'j-progress',
    ]);
    await db.end();
  });

  it('skips rows with NULL or whitespace-only addresses', async () => {
    await seed(db.client, [
      { id: 'j-null', tenant_id: 't1', status: 'pending', address: null },
      { id: 'j-blank', tenant_id: 't1', status: 'pending', address: '   ' },
      { id: 'j-real', tenant_id: 't1', status: 'pending', address: '6 Cedar St' },
    ]);

    const rows = await selectCandidates(db.client, makeOpts());
    expect(rows.map((r) => r.id)).toEqual(['j-real']);
    await db.end();
  });

  it('is idempotent: skips rows whose cached coords are already fresh for the current address', async () => {
    await seed(db.client, [
      // Already cached for the current address — must be skipped.
      {
        id: 'j-fresh',
        tenant_id: 't1',
        status: 'pending',
        address: '7 Maple Ave',
        address_lat: 40.0,
        address_lon: -74.0,
        address_geocoded_for: '7 Maple Ave',
      },
      // Has lat/lon but the address has since changed — must be re-geocoded.
      {
        id: 'j-stale',
        tenant_id: 't1',
        status: 'pending',
        address: '8 Maple Ave',
        address_lat: 40.0,
        address_lon: -74.0,
        address_geocoded_for: 'old address',
      },
      // Has only address_lat populated — must be re-geocoded.
      {
        id: 'j-half',
        tenant_id: 't1',
        status: 'pending',
        address: '9 Maple Ave',
        address_lat: 40.0,
        address_lon: null,
        address_geocoded_for: '9 Maple Ave',
      },
    ]);

    const rows = await selectCandidates(db.client, makeOpts());
    expect(rows.map((r) => r.id).sort()).toEqual(['j-half', 'j-stale']);
    await db.end();
  });

  it('orders results by tenant_id, id so per-tenant tallies are produced as contiguous blocks', async () => {
    await seed(db.client, [
      { id: 'b', tenant_id: 't2', status: 'pending', address: 'addr-b' },
      { id: 'a', tenant_id: 't2', status: 'pending', address: 'addr-a' },
      { id: 'z', tenant_id: 't1', status: 'pending', address: 'addr-z' },
      { id: 'y', tenant_id: 't1', status: 'pending', address: 'addr-y' },
    ]);

    const rows = await selectCandidates(db.client, makeOpts());
    expect(rows.map((r) => `${r.tenant_id}/${r.id}`)).toEqual([
      't1/y',
      't1/z',
      't2/a',
      't2/b',
    ]);
    await db.end();
  });

  it('--tenant=<id> narrows to a single tenant', async () => {
    await seed(db.client, [
      { id: 'a', tenant_id: 't1', status: 'pending', address: 'addr-a' },
      { id: 'b', tenant_id: 't2', status: 'pending', address: 'addr-b' },
    ]);

    const rows = await selectCandidates(db.client, makeOpts({ tenantId: 't2' }));
    expect(rows.map((r) => r.id)).toEqual(['b']);
    await db.end();
  });

  it('--limit=<n> caps the total candidate set', async () => {
    await seed(db.client, [
      { id: 'a', tenant_id: 't1', status: 'pending', address: 'addr-a' },
      { id: 'b', tenant_id: 't1', status: 'pending', address: 'addr-b' },
      { id: 'c', tenant_id: 't1', status: 'pending', address: 'addr-c' },
    ]);

    const rows = await selectCandidates(db.client, makeOpts({ limit: 2 }));
    expect(rows.length).toBe(2);
    await db.end();
  });
});

// ---------------------------------------------------------------------------
// persistCoords (idempotency + concurrent-edit safety)
// ---------------------------------------------------------------------------

describe('persistCoords', () => {
  let db: DbHandles;
  beforeEach(async () => {
    db = await makeDb();
  });

  it('writes coords to a stale row and returns rowCount=1', async () => {
    await seed(db.client, [
      { id: 'j1', tenant_id: 't1', status: 'pending', address: '10 Pine St' },
    ]);

    const written = await persistCoords(db.client, 'j1', 't1', '10 Pine St', 41.5, -73.5);
    expect(written).toBe(1);

    const { rows } = await db.client.query(
      `SELECT address_lat AS lat, address_lon AS lon, address_geocoded_for
         FROM dispatch_jobs WHERE id = 'j1'`,
    );
    // pg returns NUMERIC as a string; pg-mem returns it as a number. Coerce
    // for the assertion so the test is portable across both.
    expect(Number(rows[0].lat)).toBeCloseTo(41.5, 5);
    expect(Number(rows[0].lon)).toBeCloseTo(-73.5, 5);
    expect(rows[0].address_geocoded_for).toBe('10 Pine St');
    await db.end();
  });

  it('is a no-op the second time (rowCount=0) — script is safe to re-run', async () => {
    await seed(db.client, [
      { id: 'j1', tenant_id: 't1', status: 'pending', address: '10 Pine St' },
    ]);

    await persistCoords(db.client, 'j1', 't1', '10 Pine St', 41.5, -73.5);
    const second = await persistCoords(db.client, 'j1', 't1', '10 Pine St', 41.5, -73.5);
    expect(second).toBe(0);
    await db.end();
  });

  it('does NOT clobber a row whose address was edited between SELECT and UPDATE', async () => {
    // Concurrent edit case: the operator/user updated the address after
    // we picked the row up. The UPDATE must skip the row (rowCount=0)
    // and leave the new address untouched, otherwise we cache stale
    // coords against the new address.
    await seed(db.client, [
      { id: 'j1', tenant_id: 't1', status: 'pending', address: 'original address' },
    ]);

    // Simulate the concurrent edit happening after candidate selection.
    await db.client.query(
      `UPDATE dispatch_jobs SET address = 'edited address' WHERE id = 'j1'`,
    );

    const written = await persistCoords(
      db.client,
      'j1',
      't1',
      'original address', // what we *thought* we were geocoding
      41.5,
      -73.5,
    );
    expect(written).toBe(0);

    const { rows } = await db.client.query(
      `SELECT address, address_lat, address_geocoded_for FROM dispatch_jobs WHERE id = 'j1'`,
    );
    expect(rows[0].address).toBe('edited address');
    expect(rows[0].address_lat).toBeNull();
    expect(rows[0].address_geocoded_for).toBeNull();
    await db.end();
  });

  it('also no-ops when another worker already wrote the same coords', async () => {
    await seed(db.client, [
      {
        id: 'j1',
        tenant_id: 't1',
        status: 'pending',
        address: '11 Oak St',
        address_lat: 42.0,
        address_lon: -71.0,
        address_geocoded_for: '11 Oak St',
      },
    ]);

    const written = await persistCoords(db.client, 'j1', 't1', '11 Oak St', 42.0, -71.0);
    expect(written).toBe(0);
    await db.end();
  });
});

// ---------------------------------------------------------------------------
// runBackfill (orchestration)
// ---------------------------------------------------------------------------

describe('runBackfill', () => {
  let db: DbHandles;
  beforeEach(async () => {
    db = await makeDb();
  });

  it('dry-run leaves the DB completely untouched but still reports intended writes', async () => {
    await seed(db.client, [
      { id: 'j1', tenant_id: 't1', status: 'pending', address: 'addr-1' },
      { id: 'j2', tenant_id: 't1', status: 'completed', address: 'addr-2' },
    ]);

    const result = await runBackfill(
      db.client,
      makeOpts({ dryRun: true }),
      {
        geocode: async (address: string) => ({
          lat: address === 'addr-1' ? 1 : 2,
          lon: address === 'addr-1' ? 11 : 22,
        }),
        logger: silentLogger(),
      },
    );

    // No row should have been written.
    const { rows } = await db.client.query(
      `SELECT id, address_lat, address_lon, address_geocoded_for
         FROM dispatch_jobs ORDER BY id`,
    );
    expect(rows.every((r) => r.address_lat === null && r.address_lon === null)).toBe(true);
    expect(rows.every((r) => r.address_geocoded_for === null)).toBe(true);

    // Tally still reports intent so operators can see the would-be impact.
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.geocoded).toBe(2);
    expect(result.totals.written).toBe(2); // intent, not actual rowCount
    expect(result.totals.failed).toBe(0);
    expect(result.totals.notFound).toBe(0);
    await db.end();
  });

  it('real run writes coords, classifies not_found vs failed, and tally totals match scanned rows', async () => {
    await seed(db.client, [
      // t1 has 3 actionable rows
      { id: 't1-good', tenant_id: 't1', status: 'pending', address: 'good-1' },
      { id: 't1-miss', tenant_id: 't1', status: 'assigned', address: 'no-result' },
      { id: 't1-boom', tenant_id: 't1', status: 'en_route', address: 'boom' },
      // t2 has 1 actionable row
      { id: 't2-good', tenant_id: 't2', status: 'pending', address: 'good-2' },
    ]);

    const calls: string[] = [];
    const result = await runBackfill(
      db.client,
      makeOpts(),
      {
        geocode: async (address) => {
          calls.push(address);
          if (address === 'no-result') return null;
          if (address === 'boom') throw new Error('provider 503');
          return { lat: address === 'good-1' ? 1 : 2, lon: address === 'good-1' ? 11 : 22 };
        },
        logger: silentLogger(),
      },
    );

    // Provider was called once per candidate (rate-limit accounting is
    // gated behind minIntervalMs, which we leave unset for speed).
    expect(calls.sort()).toEqual(['boom', 'good-1', 'good-2', 'no-result']);

    // Per-tenant tallies are emitted in tenant_id order and the
    // accountancy adds back up to the totals.
    expect(result.perTenant.map((t) => t.tenantId)).toEqual(['t1', 't2']);

    const t1 = result.perTenant.find((t) => t.tenantId === 't1');
    const t2 = result.perTenant.find((t) => t.tenantId === 't2');
    expect(t1).toMatchObject({ scanned: 3, geocoded: 1, written: 1, notFound: 1, failed: 1 });
    expect(t2).toMatchObject({ scanned: 1, geocoded: 1, written: 1, notFound: 0, failed: 0 });

    // Totals === sum(perTenant) AND scanned === processed === candidate count.
    const sum = (k: keyof typeof result.totals) =>
      result.perTenant.reduce(
        (acc, t) => acc + (t as unknown as Record<string, number>)[k as string],
        0,
      );
    expect(result.totals.scanned).toBe(sum('scanned'));
    expect(result.totals.geocoded).toBe(sum('geocoded'));
    expect(result.totals.written).toBe(sum('written'));
    expect(result.totals.notFound).toBe(sum('notFound'));
    expect(result.totals.failed).toBe(sum('failed'));
    expect(result.processed).toBe(result.totals.scanned);
    expect(result.processed).toBe(4);

    // The DB reflects exactly the rows we expected to write.
    const { rows: persisted } = await db.client.query(
      `SELECT id FROM dispatch_jobs
        WHERE address_lat IS NOT NULL AND address_lon IS NOT NULL
        ORDER BY id`,
    );
    expect(persisted.map((r: { id: string }) => r.id)).toEqual(['t1-good', 't2-good']);

    await db.end();
  });

  it('honors --actionable-only end-to-end (skips completed/cancelled rows entirely)', async () => {
    await seed(db.client, [
      { id: 'open', tenant_id: 't1', status: 'pending', address: 'a' },
      { id: 'done', tenant_id: 't1', status: 'completed', address: 'b' },
    ]);

    let geocodeCalls = 0;
    const result = await runBackfill(
      db.client,
      makeOpts({ actionableOnly: true }),
      {
        geocode: async () => {
          geocodeCalls += 1;
          return { lat: 1, lon: 2 };
        },
        logger: silentLogger(),
      },
    );

    expect(geocodeCalls).toBe(1);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.written).toBe(1);

    const { rows } = await db.client.query(
      `SELECT id FROM dispatch_jobs WHERE address_lat IS NOT NULL`,
    );
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['open']);
    await db.end();
  });

  it('with the deprecated --include-all-statuses alias the run still covers ALL statuses', async () => {
    // End-to-end check that the no-op alias does not accidentally
    // narrow scope in real operator usage.
    const opts = parseArgs(['--include-all-statuses']);
    await seed(db.client, [
      { id: 'open', tenant_id: 't1', status: 'pending', address: 'a' },
      { id: 'done', tenant_id: 't1', status: 'completed', address: 'b' },
      { id: 'cancel', tenant_id: 't1', status: 'cancelled', address: 'c' },
    ]);

    const result = await runBackfill(db.client, opts, {
      geocode: async () => ({ lat: 1, lon: 2 }),
      logger: silentLogger(),
    });

    expect(result.totals.scanned).toBe(3);
    expect(result.totals.written).toBe(3);
    await db.end();
  });

  it('does NOT increment `written` when a concurrent address edit blocks the UPDATE', async () => {
    // End-to-end concurrent-edit safety: a row whose address changes
    // between SELECT and UPDATE should be classified as "geocoded but
    // not written" — *not* "failed", *not* "written". This is the
    // surface visible to operators in the per-tenant tally.
    await seed(db.client, [
      { id: 'jA', tenant_id: 't1', status: 'pending', address: 'addr-A' },
    ]);

    const result = await runBackfill(
      db.client,
      makeOpts(),
      {
        geocode: async () => {
          // Simulate the concurrent address edit happening DURING the
          // geocode round-trip (between selectCandidates and persistCoords).
          await db.client.query(
            `UPDATE dispatch_jobs SET address = 'addr-B' WHERE id = 'jA'`,
          );
          return { lat: 5, lon: 6 };
        },
        logger: silentLogger(),
      },
    );

    expect(result.totals.scanned).toBe(1);
    expect(result.totals.geocoded).toBe(1);
    expect(result.totals.written).toBe(0);
    expect(result.totals.failed).toBe(0);

    const { rows } = await db.client.query(
      `SELECT address, address_lat FROM dispatch_jobs WHERE id = 'jA'`,
    );
    expect(rows[0].address).toBe('addr-B');
    expect(rows[0].address_lat).toBeNull();

    await db.end();
  });

  it('respects the rate limiter: minIntervalMs gates consecutive geocode calls', async () => {
    // We don't want to assert on wall-clock time — that's flaky. Instead
    // we inject a sleep stub and assert it was invoked, with the right
    // gap, between successive geocode calls.
    await seed(db.client, [
      { id: 'a', tenant_id: 't1', status: 'pending', address: 'one' },
      { id: 'b', tenant_id: 't1', status: 'pending', address: 'two' },
      { id: 'c', tenant_id: 't1', status: 'pending', address: 'three' },
    ]);

    const sleeps: number[] = [];
    await runBackfill(
      db.client,
      makeOpts(),
      {
        geocode: async () => ({ lat: 1, lon: 2 }),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        minIntervalMs: 1000,
        logger: silentLogger(),
      },
    );

    // First call has no prior call to wait on; subsequent calls each
    // get a sleep gated by minIntervalMs.
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    for (const w of sleeps) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1000);
    }
  });
});
