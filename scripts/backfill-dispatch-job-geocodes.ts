/**
 * One-shot backfill for the geocode columns added by
 * `migrations/087_dispatch_jobs_geocode.sql`.
 *
 * Why: the dispatcher live map lazy-geocodes a job's address the first
 * time a tech goes en_route, which means the very first ETA after the
 * status flip can be slightly delayed (and on the free Nominatim
 * provider, rate-limited). Pre-populating `address_lat/lon` for every
 * still-open job keeps that first render snappy.
 *
 * What it does: walks every `dispatch_jobs` row that has a non-empty
 * `address` but no cached coordinates for that exact address (i.e.
 * `address_lat`/`address_lon` is NULL or `address_geocoded_for` no
 * longer matches the current `address`). By default it only touches
 * "still-actionable" statuses (pending/assigned/scheduled/en_route/
 * on_site/in_progress) so we don't waste API quota on completed or
 * cancelled history. Pass `--include-all-statuses` to widen.
 *
 * The script:
 *   - is safe to re-run (rows that already have a fresh, address-matched
 *     cache are skipped by the SELECT predicate);
 *   - respects the configured geocoder's rate limit. For Nominatim we
 *     default to 1 req/sec per the OSM usage policy. Override with
 *     `--rps=<n>` or `DISPATCH_GEOCODE_BACKFILL_RPS=<n>`;
 *   - walks the table in tenant order so each tenant's results are
 *     reported as a contiguous block, and stamps a per-tenant
 *     success / not_found / failure tally at the end;
 *   - supports `--dry-run` to count what would change without writing.
 *
 * Usage (development):
 *   APP_ENV=development DATABASE_URL=postgres://... \
 *     npx tsx scripts/backfill-dispatch-job-geocodes.ts
 * Usage (production):
 *   APP_ENV=production PLATFORM_DB_POOL_URL=postgres://... \
 *     npx tsx scripts/backfill-dispatch-job-geocodes.ts
 *
 * Optional flags:
 *   --dry-run                   Report what would change, write nothing.
 *   --include-all-statuses      Also backfill done/cancelled/completed/incomplete jobs.
 *   --tenant=<id>               Limit to a single tenant_id.
 *   --limit=<n>                 Stop after processing N rows total (useful for smoke tests).
 *   --rps=<n>                   Requests-per-second cap (overrides provider default).
 */

import { Pool, type PoolClient } from 'pg';
import {
  geocodeAddress,
  getConfiguredGeocoderProvider,
} from '../platform/integrations/routing/geocoder';
import type { GeocoderProviderName } from '../platform/integrations/routing/types';

interface CliOptions {
  dryRun: boolean;
  includeAllStatuses: boolean;
  tenantId: string | null;
  limit: number | null;
  rps: number | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let dryRun = false;
  let includeAllStatuses = false;
  let tenantId: string | null = null;
  let limit: number | null = null;
  let rps: number | null = null;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--include-all-statuses') {
      includeAllStatuses = true;
    } else if (arg.startsWith('--tenant=')) {
      const v = arg.slice('--tenant='.length).trim();
      if (v) tenantId = v;
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (arg.startsWith('--rps=')) {
      const n = Number.parseFloat(arg.slice('--rps='.length));
      if (Number.isFinite(n) && n > 0) rps = n;
    }
  }

  return { dryRun, includeAllStatuses, tenantId, limit, rps };
}

/**
 * Default request-per-second cap by provider. These match each
 * provider's published free-tier policy, NOT a paid contract — operators
 * should override with `--rps=` when they have a higher quota.
 *   - nominatim: 1 req/sec absolute max (OSM usage policy)
 *   - mapbox:    600 req/min on the free tier → 10 req/sec; we leave a
 *                little headroom and default to 5 req/sec
 *   - google:    50 req/sec hard limit on the Geocoding API; we default
 *                to 10 req/sec to stay polite and predictable
 *   - none:      irrelevant (no requests issued)
 */
function defaultRpsFor(provider: GeocoderProviderName): number {
  switch (provider) {
    case 'mapbox':
      return 5;
    case 'google':
      return 10;
    case 'none':
      return 1;
    case 'nominatim':
    default:
      return 1;
  }
}

function getRpsCap(provider: GeocoderProviderName, override: number | null): number {
  if (override != null) return override;
  const envRaw = process.env.DISPATCH_GEOCODE_BACKFILL_RPS;
  if (envRaw) {
    const n = Number.parseFloat(envRaw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return defaultRpsFor(provider);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JobRow {
  id: string;
  tenant_id: string;
  address: string;
}

interface PerTenantResult {
  tenantId: string;
  scanned: number;
  geocoded: number;
  written: number;
  notFound: number;
  failed: number;
}

/**
 * Per-row error/no-result logs include the address as a debugging aid,
 * but those logs are commonly piped to long-retention sinks. Emit only
 * a short, non-reversible fingerprint so we can correlate individual
 * row failures across runs without leaking the customer's full street
 * address into the log archive.
 */
function maskAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return '<empty>';
  const head = trimmed.slice(0, 4);
  return `${head}***(len=${trimmed.length})`;
}

const ACTIONABLE_STATUSES = [
  'pending',
  'assigned',
  'scheduled',
  'en_route',
  'on_site',
  'in_progress',
];

async function selectCandidates(
  client: PoolClient,
  opts: CliOptions,
): Promise<JobRow[]> {
  const conditions: string[] = [
    "address IS NOT NULL",
    "btrim(address) <> ''",
    // Either no cached coords, or the cache is stale relative to the
    // current address string (mirrors the dispatcher's runtime check).
    "(address_lat IS NULL OR address_lon IS NULL OR address_geocoded_for IS DISTINCT FROM address)",
  ];
  const params: unknown[] = [];

  if (!opts.includeAllStatuses) {
    params.push(ACTIONABLE_STATUSES);
    conditions.push(`status = ANY($${params.length}::text[])`);
  }
  if (opts.tenantId) {
    params.push(opts.tenantId);
    conditions.push(`tenant_id = $${params.length}`);
  }

  let sql = `SELECT id, tenant_id, address
               FROM dispatch_jobs
              WHERE ${conditions.join(' AND ')}
              ORDER BY tenant_id ASC, id ASC`;
  if (opts.limit != null) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const { rows } = await client.query<JobRow>(sql, params);
  return rows;
}

async function persistCoords(
  client: PoolClient,
  jobId: string,
  tenantId: string,
  addressGeocodedFor: string,
  lat: number,
  lon: number,
): Promise<number> {
  // Re-check `address_geocoded_for IS DISTINCT FROM` so a concurrent
  // address edit between SELECT and UPDATE doesn't get clobbered with
  // stale coords. The returned `rowCount` is therefore the number of
  // jobs we *actually* wrote (a concurrent edit will silently leave
  // the row alone, distinct from a successful geocode).
  const result = await client.query(
    `UPDATE dispatch_jobs
        SET address_lat = $1,
            address_lon = $2,
            address_geocoded_at = NOW(),
            address_geocoded_for = $3
      WHERE id = $4
        AND tenant_id = $5
        AND address = $3
        AND (address_lat IS NULL
             OR address_lon IS NULL
             OR address_geocoded_for IS DISTINCT FROM $3)`,
    [lat, lon, addressGeocodedFor, jobId, tenantId],
  );
  return result.rowCount ?? 0;
}

function emitTenantSummary(result: PerTenantResult): void {
  console.log(
    `[BACKFILL]   tenant=${result.tenantId} scanned=${result.scanned} ` +
      `geocoded=${result.geocoded} written=${result.written} ` +
      `not_found=${result.notFound} failed=${result.failed}`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const env = process.env.APP_ENV ?? 'development';
  let url: string;
  let sslConfig: { rejectUnauthorized: boolean } | false = false;

  if (env === 'development') {
    url = process.env.DATABASE_URL ?? '';
    if (!url) {
      throw new Error('[BACKFILL] DATABASE_URL is not set for development.');
    }
  } else {
    url = process.env.PLATFORM_DB_POOL_URL ?? '';
    if (!url) {
      throw new Error('[BACKFILL] PLATFORM_DB_POOL_URL is not set for production/staging.');
    }
    sslConfig = { rejectUnauthorized: false };
  }

  const provider = getConfiguredGeocoderProvider();
  const rps = getRpsCap(provider, opts.rps);
  const minIntervalMs = Math.ceil(1000 / rps);

  console.log(
    `[BACKFILL] Environment: ${env}${opts.dryRun ? ' (DRY RUN)' : ''} provider=${provider} rps=${rps}`,
  );
  if (provider === 'none') {
    console.log('[BACKFILL] Provider is "none" — nothing to do. Exiting.');
    return;
  }

  const pool = new Pool({
    connectionString: url,
    max: 2,
    ...(sslConfig ? { ssl: sslConfig } : {}),
  });

  const client = await pool.connect();
  const perTenant = new Map<string, PerTenantResult>();
  let processed = 0;

  try {
    console.log('[BACKFILL] Selecting candidate jobs ...');
    const candidates = await selectCandidates(client, opts);
    console.log(`[BACKFILL] ${candidates.length} candidate row(s) selected.`);

    let lastCallAt = 0;

    for (const job of candidates) {
      let bucket = perTenant.get(job.tenant_id);
      if (!bucket) {
        bucket = {
          tenantId: job.tenant_id,
          scanned: 0,
          geocoded: 0,
          written: 0,
          notFound: 0,
          failed: 0,
        };
        perTenant.set(job.tenant_id, bucket);
      }
      bucket.scanned += 1;
      processed += 1;

      const address = job.address.trim();
      if (!address) {
        // Defensive — selectCandidates already filters this out.
        continue;
      }

      // Rate limit: ensure at least minIntervalMs between provider calls.
      const now = Date.now();
      const wait = lastCallAt + minIntervalMs - now;
      if (wait > 0) {
        await sleep(wait);
      }
      lastCallAt = Date.now();

      try {
        const point = await geocodeAddress(address, provider);
        if (!point) {
          bucket.notFound += 1;
          console.warn(
            `[BACKFILL] no_result tenant=${job.tenant_id} job=${job.id} address=${maskAddress(address)}`,
          );
          continue;
        }
        bucket.geocoded += 1;
        if (!opts.dryRun) {
          const written = await persistCoords(
            client,
            job.id,
            job.tenant_id,
            address,
            point.lat,
            point.lon,
          );
          bucket.written += written;
          if (written === 0) {
            // Either a concurrent address edit raced us, or another
            // backfill instance already wrote the same coords. Either
            // way the job is in a consistent state — log it as info
            // rather than failed so the totals stay meaningful.
            console.warn(
              `[BACKFILL] no_write tenant=${job.tenant_id} job=${job.id} address=${maskAddress(address)} (concurrent edit or already populated)`,
            );
          }
        } else {
          // In dry-run we don't actually UPDATE, but the row *would*
          // have been written, so reflect that intent in the tally.
          bucket.written += 1;
        }
      } catch (err) {
        bucket.failed += 1;
        console.error(
          `[BACKFILL] error tenant=${job.tenant_id} job=${job.id} address=${maskAddress(address)} error=${String(err)}`,
        );
      }

      // Per-tenant rolling progress every 25 rows so long runs are observable
      // without spamming the log on small batches.
      if (bucket.scanned % 25 === 0) {
        emitTenantSummary(bucket);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log('[BACKFILL] Per-tenant results:');
  const tenants = Array.from(perTenant.values()).sort((a, b) =>
    a.tenantId.localeCompare(b.tenantId),
  );
  for (const r of tenants) emitTenantSummary(r);

  const totals = tenants.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      geocoded: acc.geocoded + r.geocoded,
      written: acc.written + r.written,
      notFound: acc.notFound + r.notFound,
      failed: acc.failed + r.failed,
    }),
    { scanned: 0, geocoded: 0, written: 0, notFound: 0, failed: 0 },
  );

  console.log('[BACKFILL] Done.');
  console.log(
    `[BACKFILL] Totals — tenants=${tenants.length} scanned=${totals.scanned} ` +
      `geocoded=${totals.geocoded} written=${totals.written} ` +
      `not_found=${totals.notFound} failed=${totals.failed}` +
      `${opts.dryRun ? ' (no writes performed)' : ''}`,
  );

  if (opts.limit != null && processed >= opts.limit) {
    console.log(`[BACKFILL] Stopped after --limit=${opts.limit} rows.`);
  }
}

main().catch((err) => {
  console.error('[BACKFILL] Failed:', err);
  process.exit(1);
});
