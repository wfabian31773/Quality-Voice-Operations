import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';

const logger = createLogger('MARKETING_SEARCH_ANALYTICS');
const router = Router();

// Sources accepted by the public ingest endpoint. Mirrors the CHECK
// constraint in `migrations/108_marketing_search_empty_queries.sql`.
const ALLOWED_SOURCES = new Set([
  'help_widget',
  'resources',
  'docs_help_widget',
  'docs_search',
]);

const MAX_QUERY_RAW_LEN = 512;
const MAX_QUERY_NORMALIZED_LEN = 256;
const MAX_LOCALE_LEN = 16;
const MAX_PAGE_PATH_LEN = 512;

/**
 * Best-effort, fire-and-forget IP throttle so a single tab mashing the
 * search box can't flood the table. Lives in-process: we want a low ceiling
 * (a few zero-hit logs/second per IP), not strict accounting. Restarts
 * reset the bucket which is fine for telemetry.
 */
const ipBucket = new Map<string, { count: number; windowStartedAt: number }>();
const IP_WINDOW_MS = 10_000;
const IP_MAX_PER_WINDOW = 30;

function isIpThrottled(ip: string): boolean {
  const now = Date.now();
  const entry = ipBucket.get(ip);
  if (!entry || now - entry.windowStartedAt >= IP_WINDOW_MS) {
    ipBucket.set(ip, { count: 1, windowStartedAt: now });
    return false;
  }
  entry.count += 1;
  if (entry.count > IP_MAX_PER_WINDOW) {
    return true;
  }
  return false;
}

// Periodic GC so the map can't grow unboundedly across distinct IPs.
setInterval(() => {
  const cutoff = Date.now() - IP_WINDOW_MS * 6;
  for (const [ip, entry] of ipBucket.entries()) {
    if (entry.windowStartedAt < cutoff) ipBucket.delete(ip);
  }
}, IP_WINDOW_MS * 6).unref?.();

export function normalizeQuery(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Public ingest endpoint. Called by the marketing-page search consumers
 * (HelpWidget, Resources) when a user-typed query returned zero matches in
 * their active locale. The body is validated and inserted; any failure is
 * swallowed (telemetry must never break the search UX).
 */
router.post('/marketing/search/empty', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    query?: unknown;
    locale?: unknown;
    source?: unknown;
    page_path?: unknown;
  };

  const queryRaw = typeof body.query === 'string' ? body.query : '';
  const locale = typeof body.locale === 'string' ? body.locale : '';
  const source = typeof body.source === 'string' ? body.source : '';
  const pagePath =
    typeof body.page_path === 'string' && body.page_path.length > 0
      ? body.page_path.slice(0, MAX_PAGE_PATH_LEN)
      : null;

  if (!queryRaw || queryRaw.length > MAX_QUERY_RAW_LEN) {
    res.status(400).json({ error: 'query is required' });
    return;
  }
  if (!locale || locale.length > MAX_LOCALE_LEN) {
    res.status(400).json({ error: 'locale is required' });
    return;
  }
  if (!ALLOWED_SOURCES.has(source)) {
    res.status(400).json({ error: 'invalid source' });
    return;
  }

  const queryNormalized = normalizeQuery(queryRaw).slice(0, MAX_QUERY_NORMALIZED_LEN);
  if (!queryNormalized) {
    // All-whitespace queries shouldn't have been logged by the client; if we
    // see one anyway, just no-op so we don't insert junk.
    res.json({ success: true, skipped: true });
    return;
  }

  const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').toString();
  if (isIpThrottled(ip)) {
    res.status(429).json({ error: 'rate limited' });
    return;
  }

  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO marketing_search_empty_queries
         (query_normalized, query_raw, locale, source, page_path, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        queryNormalized,
        queryRaw.slice(0, MAX_QUERY_RAW_LEN),
        locale,
        source,
        pagePath,
        req.headers['user-agent']?.toString().slice(0, 512) ?? null,
      ],
    );
  } catch (err) {
    // Telemetry must never break the search UX. Log a warning so ops can
    // notice if the table is misconfigured, but always return success.
    logger.warn('marketing_search_empty_queries insert failed', {
      error: String(err),
    });
  }

  res.json({ success: true });
});

interface EmptyQueryRow {
  query_normalized: string;
  query_raw_sample: string;
  locale: string;
  source: string;
  hit_count: number;
  last_seen_at: string;
  first_seen_at: string;
  distinct_page_paths: number;
}

/**
 * Admin summary: aggregated zero-hit queries grouped by
 * (source, locale, query_normalized) so platform admins can see which
 * translated phrases people are typing that aren't in the marketing
 * catalog. Findings should feed back into the
 * `client-app/src/locales/<locale>/marketing.json` keyword catalogs.
 */
router.get(
  '/marketing/search/empty/summary',
  requireAuth,
  requirePlatformAdmin,
  async (req: Request, res: Response) => {
    const sinceDays = Math.min(
      Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1),
      365,
    );
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1),
      500,
    );
    const localeFilter =
      typeof req.query.locale === 'string' && req.query.locale.length > 0
        ? req.query.locale.slice(0, MAX_LOCALE_LEN)
        : null;
    const sourceFilter =
      typeof req.query.source === 'string' && ALLOWED_SOURCES.has(req.query.source)
        ? req.query.source
        : null;

    const params: unknown[] = [sinceDays];
    let where = `WHERE created_at >= now() - ($1 || ' days')::interval`;
    if (localeFilter) {
      params.push(localeFilter);
      where += ` AND locale = $${params.length}`;
    }
    if (sourceFilter) {
      params.push(sourceFilter);
      where += ` AND source = $${params.length}`;
    }
    params.push(limit);

    try {
      const pool = getPlatformPool();
      const r = await pool.query<EmptyQueryRow>(
        `SELECT
           query_normalized,
           (array_agg(query_raw ORDER BY created_at DESC))[1] AS query_raw_sample,
           locale,
           source,
           COUNT(*)::int AS hit_count,
           MAX(created_at)::text AS last_seen_at,
           MIN(created_at)::text AS first_seen_at,
           COUNT(DISTINCT page_path)::int AS distinct_page_paths
         FROM marketing_search_empty_queries
         ${where}
         GROUP BY query_normalized, locale, source
         ORDER BY hit_count DESC, MAX(created_at) DESC
         LIMIT $${params.length}`,
        params,
      );

      // Per-locale counts for the summary header. Uses the SAME WHERE
      // clause (and parameters, minus the trailing LIMIT) as the rows
      // query so the header totals stay consistent with whichever
      // source/locale filters the admin has applied. Without this, the
      // header could show e.g. 500 rows in `de` while the filtered table
      // below shows zero, which is confusing.
      const localeCountParams = params.slice(0, params.length - 1);
      const localeCounts = await pool.query<{ locale: string; total: number }>(
        `SELECT locale, COUNT(*)::int AS total
         FROM marketing_search_empty_queries
         ${where}
         GROUP BY locale
         ORDER BY total DESC`,
        localeCountParams,
      );

      res.json({
        days: sinceDays,
        rows: r.rows,
        locale_totals: localeCounts.rows,
      });
    } catch (err) {
      logger.error('marketing_search_empty_queries summary failed', {
        error: String(err),
      });
      res.status(500).json({ error: 'Failed to load summary' });
    }
  },
);

export default router;
