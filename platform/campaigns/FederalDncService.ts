import { getPlatformPool, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('FEDERAL_DNC');

/**
 * Cache the current registry version on the process so the hot pre-flight
 * path doesn't re-query `federal_dnc_sync_state` for every batch. The cache
 * is bounded to `VERSION_CACHE_TTL_MS` so a freshly-completed sync is picked
 * up within a few minutes without a process restart.
 */
let cachedVersion: { value: string | null; loadedAt: number } | null = null;
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000;

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/**
 * Look up the registry version recorded by the most recent successful sync.
 * Returns `null` when the platform has never synced (e.g. fresh install,
 * subscription credentials missing) — callers should still record federal
 * blocks but with a `registry_version` of `'unknown'` in the audit log.
 */
export async function getCurrentFederalDncVersion(): Promise<string | null> {
  const now = Date.now();
  if (cachedVersion && now - cachedVersion.loadedAt < VERSION_CACHE_TTL_MS) {
    return cachedVersion.value;
  }
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT last_registry_version FROM federal_dnc_sync_state WHERE id = 1 LIMIT 1`,
    );
    const value = rows.length > 0 ? ((rows[0] as { last_registry_version: string | null }).last_registry_version ?? null) : null;
    cachedVersion = { value, loadedAt: now };
    return value;
  } catch (err) {
    // Most likely cause: migration 083 hasn't been applied yet. Don't fail
    // the pre-flight — just behave as if no federal sync has happened.
    logger.warn('Failed to read federal DNC sync state', { error: String(err) });
    return null;
  }
}

/**
 * Reset the in-process registry-version cache. Called by the sync scheduler
 * after a successful sync so the next compliance check picks up the new
 * version without waiting `VERSION_CACHE_TTL_MS`.
 */
export function clearFederalDncVersionCache(): void {
  cachedVersion = null;
}

/**
 * Membership lookup for a *batch* of phone numbers. Returns a Set containing
 * the subset that are on the federal registry. Used by the compliance
 * pre-flight (which decrypts contacts in 1k-row chunks) and by
 * `findDncMatchingContactIds` for the auto-scrub path.
 *
 * Implemented as a single `WHERE phone_number = ANY($1::varchar[])` so we
 * don't need to load the entire registry (~250M numbers) into memory. The
 * federal table is platform-scoped (no RLS), but we deliberately use the
 * caller's tenant-scoped client so the query rides on whatever transaction
 * the pre-flight already opened — no extra connection per batch.
 */
export async function findFederalDncMatches(
  client: DbClient,
  phones: string[],
): Promise<Set<string>> {
  if (phones.length === 0) return new Set();
  try {
    const { rows } = await client.query(
      `SELECT phone_number FROM federal_dnc_numbers WHERE phone_number = ANY($1::varchar[])`,
      [phones],
    );
    return new Set(rows.map((r) => String(r.phone_number)));
  } catch (err) {
    // If the federal table doesn't exist yet (migration not applied) we
    // log once and degrade to "no federal matches" so the tenant DNC list
    // still works. Operators see the warning + the sync state will show
    // 'never_synced' so they can fix the deploy.
    logger.warn('Federal DNC batch lookup failed; degrading to tenant-only DNC', {
      error: String(err),
      batchSize: phones.length,
    });
    return new Set();
  }
}

/**
 * Single-number membership check. Used by the dial-time defense-in-depth
 * checks in `OutboundDialer.dialContact` and `CampaignScheduler` so a number
 * added to the federal registry between pre-flight and dial is still blocked.
 *
 * Returns the registry version that matched so the caller can stamp it on the
 * audit log for the resulting block.
 */
export async function isOnFederalDnc(phoneNumber: string): Promise<{ onDnc: boolean; registryVersion: string | null }> {
  if (!phoneNumber) return { onDnc: false, registryVersion: null };
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT registry_version FROM federal_dnc_numbers WHERE phone_number = $1 LIMIT 1`,
      [phoneNumber],
    );
    if (rows.length === 0) return { onDnc: false, registryVersion: null };
    return {
      onDnc: true,
      registryVersion: String((rows[0] as { registry_version: string }).registry_version),
    };
  } catch (err) {
    logger.warn('Federal DNC single-number lookup failed', { error: String(err) });
    return { onDnc: false, registryVersion: null };
  }
}

export interface FederalDncSyncState {
  lastSyncStartedAt: Date | null;
  lastSyncCompletedAt: Date | null;
  lastRegistryVersion: string | null;
  lastRecordCount: number | null;
  lastStatus: string | null;
  lastError: string | null;
  updatedAt: Date | null;
}

export async function getFederalDncSyncState(): Promise<FederalDncSyncState> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<{
    last_sync_started_at: Date | null;
    last_sync_completed_at: Date | null;
    last_registry_version: string | null;
    last_record_count: number | null;
    last_status: string | null;
    last_error: string | null;
    updated_at: Date | null;
  }>(`SELECT last_sync_started_at, last_sync_completed_at, last_registry_version,
             last_record_count, last_status, last_error, updated_at
      FROM federal_dnc_sync_state WHERE id = 1 LIMIT 1`);
  if (rows.length === 0) {
    return {
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastRegistryVersion: null,
      lastRecordCount: null,
      lastStatus: null,
      lastError: null,
      updatedAt: null,
    };
  }
  const r = rows[0];
  return {
    lastSyncStartedAt: r.last_sync_started_at ?? null,
    lastSyncCompletedAt: r.last_sync_completed_at ?? null,
    lastRegistryVersion: r.last_registry_version,
    lastRecordCount: r.last_record_count,
    lastStatus: r.last_status,
    lastError: r.last_error,
    updatedAt: r.updated_at ?? null,
  };
}

/**
 * Normalize a registry record to the E.164 form we store in `dnc_list` and
 * `campaign_contacts`. The FTC distributes 10-digit NANP numbers (no country
 * code, no formatting) — we add the `+1` prefix so the membership check
 * succeeds against the same normalization our outbound contact import uses.
 *
 * Returns `null` for anything that isn't a 10- or 11-digit US number so the
 * sync skips garbage rows (file corruption, unexpected international entries)
 * without aborting the whole import.
 */
export function normalizeFederalDncNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export interface FederalDncSyncResult {
  status: 'completed' | 'skipped' | 'failed';
  reason?: string;
  registryVersion?: string;
  recordCount?: number;
  durationMs?: number;
}

interface SyncOptions {
  /**
   * Override the source URL — used by tests to point at a fixture instead of
   * the real FTC API. Defaults to `process.env.FEDERAL_DNC_SOURCE_URL`.
   */
  sourceUrl?: string;
  /**
   * Override the registry version recorded for this sync — used by tests.
   * Production reads the `Last-Modified` response header (or, falling back,
   * the current ISO date).
   */
  versionOverride?: string;
  /**
   * Override the fetch implementation — used by tests to inject a stub. The
   * stub must return a Response whose body is a string of newline-delimited
   * 10-digit phone numbers.
   */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * Maximum number of phone-number rows to insert per batch. Sized to keep
   * the parameterized INSERT under the Postgres parameter limit (65535).
   */
  insertBatchSize?: number;
}

const DEFAULT_INSERT_BATCH_SIZE = 5000;

/**
 * Pull the FTC National DNC Registry snapshot and refresh `federal_dnc_numbers`.
 *
 * Production flow:
 *   1. GET the configured source URL with HTTP Basic auth (subscription
 *      credentials issued by telemarketing.donotcall.gov). Body is expected
 *      to be a newline-delimited list of 10-digit NANP numbers (~250M rows
 *      = several gigabytes — never buffer it whole).
 *   2. Stream the response body chunk-by-chunk via `response.body.getReader()`.
 *      A running UTF-8 buffer reassembles partial lines across chunks; each
 *      complete line is normalized to E.164 and pushed into a bounded
 *      `pendingBatch`. When the batch hits `insertBatchSize` (5k rows by
 *      default) we run a single parameterized INSERT ... ON CONFLICT DO
 *      UPDATE SET registry_version = EXCLUDED.registry_version and reset
 *      the batch — so memory stays bounded by one chunk + one batch + one
 *      decoder, not the snapshot size.
 *   3. After the load, delete any row whose `registry_version` is older than
 *      the new one — those numbers were removed from the federal list and
 *      should no longer block dialing. If the stream produced zero parseable
 *      numbers we throw before pruning so an empty/garbage snapshot can't
 *      silently wipe the table.
 *   4. Update `federal_dnc_sync_state` with the new version + record count.
 *
 * Skipped flow: when subscription credentials are missing
 * (`FEDERAL_DNC_USERNAME` / `FEDERAL_DNC_PASSWORD` unset) the sync logs a
 * warning and records a `skipped` status with the reason. The compliance
 * pre-flight still works against whatever snapshot is already loaded; only
 * net-new numbers since the last successful sync would be missed.
 */
export async function syncFederalDncRegistry(opts: SyncOptions = {}): Promise<FederalDncSyncResult> {
  const startedAt = new Date();
  const sourceUrl = opts.sourceUrl ?? process.env.FEDERAL_DNC_SOURCE_URL ?? '';
  const username = process.env.FEDERAL_DNC_USERNAME ?? '';
  const password = process.env.FEDERAL_DNC_PASSWORD ?? '';

  await markSyncStarted(startedAt);

  if (!sourceUrl) {
    const reason = 'FEDERAL_DNC_SOURCE_URL is not set; skipping federal DNC sync';
    logger.warn(reason);
    await markSyncCompleted({ status: 'skipped', error: reason, version: null, recordCount: null });
    return { status: 'skipped', reason };
  }

  // Credentials are technically optional (the URL might be a fixture or a
  // self-hosted mirror without basic auth) — emit a one-line note when
  // they're missing rather than failing.
  const hasBasicAuth = Boolean(username && password);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);

  let response: Response;
  try {
    response = await fetchImpl(sourceUrl, {
      method: 'GET',
      headers: hasBasicAuth
        ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
        : undefined,
    });
  } catch (err) {
    const message = `Federal DNC fetch failed: ${String(err).slice(0, 500)}`;
    logger.error(message);
    await markSyncCompleted({ status: 'failed', error: message, version: null, recordCount: null });
    return { status: 'failed', reason: message };
  }

  if (!response.ok) {
    const message = `Federal DNC fetch returned HTTP ${response.status} ${response.statusText}`;
    logger.error(message);
    await markSyncCompleted({ status: 'failed', error: message, version: null, recordCount: null });
    return { status: 'failed', reason: message };
  }

  const lastModified = response.headers.get('last-modified');
  const registryVersion = opts.versionOverride
    ?? (lastModified ? `lm:${lastModified}` : `iso:${startedAt.toISOString()}`);

  const insertBatchSize = opts.insertBatchSize ?? DEFAULT_INSERT_BATCH_SIZE;

  // Streaming load. The federal snapshot is large (~250M rows = a few GB of
  // newline-delimited text), so we MUST NOT materialize the whole body in
  // memory — we read the response body chunk-by-chunk, decode UTF-8 with a
  // running buffer for partial lines, accumulate normalized phones into a
  // bounded `pendingBatch`, and flush each time we hit `insertBatchSize`.
  // Bounded memory (one batch + the line buffer + one decoder), bounded
  // round-trips (one INSERT per `insertBatchSize` numbers), and a single
  // post-load prune to remove numbers that dropped off this snapshot.
  let totalCount = 0;
  const sentinel = { wipeRefused: false } as { wipeRefused: boolean };

  try {
    await withPrivilegedClient(async (client) => {
      let pendingBatch: string[] = [];

      const flush = async (): Promise<void> => {
        if (pendingBatch.length === 0) return;
        const chunk = pendingBatch;
        pendingBatch = [];
        const placeholders = chunk
          .map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`)
          .join(', ');
        const params: unknown[] = [];
        for (const phone of chunk) {
          params.push(phone, registryVersion);
        }
        await client.query(
          `INSERT INTO federal_dnc_numbers (phone_number, registry_version)
           VALUES ${placeholders}
           ON CONFLICT (phone_number) DO UPDATE SET
             registry_version = EXCLUDED.registry_version,
             added_at = NOW()`,
          params,
        );
        totalCount += chunk.length;
      };

      const consumeLine = async (line: string): Promise<void> => {
        const normalized = normalizeFederalDncNumber(line.trim());
        if (!normalized) return;
        pendingBatch.push(normalized);
        if (pendingBatch.length >= insertBatchSize) {
          await flush();
        }
      };

      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        // Iterate the Web ReadableStream chunk-by-chunk. We never hold more
        // than one chunk + the partial-line buffer + one batch in memory.
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf('\n');
          while (nl !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            await consumeLine(line);
            nl = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) {
          await consumeLine(buffer);
        }
      } else {
        // Fallback for runtimes / test stubs where the Response has no
        // streamable body (older fetch polyfills, mocked Responses). This is
        // expected to be rare and is only safe for *small* bodies — the
        // production registry snapshot always exposes `response.body`.
        const fallbackBody = await response.text();
        for (const line of fallbackBody.split(/\r?\n/)) {
          await consumeLine(line);
        }
      }

      await flush();

      if (totalCount === 0) {
        // Refuse to prune: an empty snapshot would silently wipe the table
        // and cause the next pre-flight to allow every previously-blocked
        // number through. Throw so the outer catch records `failed`.
        sentinel.wipeRefused = true;
        throw new Error('Federal DNC source returned zero parseable numbers; refusing to wipe table');
      }

      // Post-load prune: numbers whose version wasn't refreshed by this load
      // dropped off the snapshot and should no longer block dialing.
      await client.query(
        `DELETE FROM federal_dnc_numbers WHERE registry_version <> $1`,
        [registryVersion],
      );
    });
  } catch (err) {
    const message = sentinel.wipeRefused
      ? `Federal DNC source returned zero parseable numbers; refusing to wipe table`
      : `Federal DNC bulk load failed: ${String(err).slice(0, 500)}`;
    if (sentinel.wipeRefused) {
      logger.error(message);
      await markSyncCompleted({ status: 'failed', error: message, version: null, recordCount: 0 });
    } else {
      logger.error(message);
      await markSyncCompleted({
        status: 'failed',
        error: message,
        version: registryVersion,
        recordCount: totalCount,
      });
    }
    return { status: 'failed', reason: message };
  }

  await markSyncCompleted({
    status: 'completed',
    error: null,
    version: registryVersion,
    recordCount: totalCount,
  });
  clearFederalDncVersionCache();

  const durationMs = Date.now() - startedAt.getTime();
  logger.info('Federal DNC sync completed', {
    registryVersion,
    recordCount: totalCount,
    durationMs,
  });
  return {
    status: 'completed',
    registryVersion,
    recordCount: totalCount,
    durationMs,
  };
}

async function markSyncStarted(startedAt: Date): Promise<void> {
  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO federal_dnc_sync_state (id, last_sync_started_at, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET
         last_sync_started_at = EXCLUDED.last_sync_started_at,
         updated_at = NOW()`,
      [startedAt],
    );
  } catch (err) {
    logger.warn('Failed to mark federal DNC sync as started', { error: String(err) });
  }
}

async function markSyncCompleted(params: {
  status: 'completed' | 'skipped' | 'failed';
  error: string | null;
  version: string | null;
  recordCount: number | null;
}): Promise<void> {
  try {
    const pool = getPlatformPool();
    await pool.query(
      `UPDATE federal_dnc_sync_state SET
         last_sync_completed_at = NOW(),
         last_status = $1,
         last_error = $2,
         last_registry_version = COALESCE($3, last_registry_version),
         last_record_count = COALESCE($4, last_record_count),
         updated_at = NOW()
       WHERE id = 1`,
      [params.status, params.error, params.version, params.recordCount],
    );
  } catch (err) {
    logger.warn('Failed to mark federal DNC sync as completed', { error: String(err) });
  }
}
