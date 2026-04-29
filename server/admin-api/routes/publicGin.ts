import { Router } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import {
  readCachedPublicBenchmark,
  writeCachedPublicBenchmark,
  type PublicBenchmarkPayload,
  type PublicBenchmarkRow,
} from '../../../platform/gin/publicBenchmarkCache';
import {
  getCsatByDispatchToken,
  recordCsatResponse,
} from '../../../platform/analytics/CsatSurveyService';

const logger = createLogger('PUBLIC_GIN_API');
const router = Router();

const PUBLIC_K_ANONYMITY = Number(process.env.GIN_PUBLIC_K_ANONYMITY ?? 8);

/**
 * Marketing / legal sign-off gate.
 *
 * The aggregation pipeline already enforces a k-anonymity threshold per row,
 * but publishing the cohort statistics on the public marketing page also
 * requires a human approval step (marketing + legal). Until this env var is
 * explicitly set to a truthy value the route refuses to advertise the
 * snapshot as "live" — it is downgraded to "preview" so the disclosure
 * copy and status pill stay honest about the page being a private beta.
 *
 * Accepts: '1', 'true', 'yes', 'on' (case-insensitive). Anything else, or
 * the variable being unset, keeps the gate closed.
 */
function isLivePublishingApproved(): boolean {
  const raw = String(process.env.GIN_PUBLIC_LIVE_APPROVED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

interface PublicMetricSpec {
  metric: string;
  vertical: string;
  verticalLabel: string;
  metricLabel: string;
  format: 'percent' | 'duration' | 'score';
}

const PUBLIC_METRICS: PublicMetricSpec[] = [
  { vertical: 'medical', verticalLabel: 'Healthcare', metric: 'call_completion_rate', metricLabel: 'After-hours answer rate', format: 'percent' },
  { vertical: 'home_services', verticalLabel: 'Field service', metric: 'avg_call_duration_seconds', metricLabel: 'Average handle time', format: 'duration' },
  { vertical: 'dental', verticalLabel: 'Dental', metric: 'booking_conversion_rate', metricLabel: 'Booking conversion', format: 'percent' },
  { vertical: 'property_management', verticalLabel: 'Real estate', metric: 'booking_conversion_rate', metricLabel: 'Lead-to-tour rate', format: 'percent' },
  // Real customer-reported CSAT (0–10) from `call_csat_responses`. The
  // GIN aggregation pipeline only writes a `csat_score` row for a vertical
  // once at least CSAT_TENANT_MIN_RESPONSES tenants have collected real
  // surveys; we additionally gate on the public k-anonymity threshold
  // below so we never publish CSAT for a vertical with too few tenants.
  { vertical: 'medical', verticalLabel: 'Healthcare', metric: 'csat_score', metricLabel: 'CSAT (post-call survey, 0–10)', format: 'score' },
  { vertical: 'legal', verticalLabel: 'Legal', metric: 'csat_score', metricLabel: 'CSAT (post-call survey, 0–10)', format: 'score' },
];

function formatValue(raw: number, format: PublicMetricSpec['format']): string {
  if (!Number.isFinite(raw)) return '—';
  if (format === 'percent') {
    return `${Math.round(raw * 100)}%`;
  }
  if (format === 'duration') {
    const total = Math.max(0, Math.round(raw));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
  }
  if (format === 'score') {
    if (raw <= 1) return raw.toFixed(2);
    if (raw <= 10) return `${raw.toFixed(1)} / 10`;
    return raw.toFixed(1);
  }
  return String(raw);
}

const publicGinLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  message: 'GIN public benchmark rate limit exceeded.',
  keyGenerator: (req) => `public-gin:${req.ip ?? 'anon'}`,
});

const PUBLIC_CACHE_HEADERS = {
  // Allow shared caches (CDN, reverse proxy) to cache for an hour, browsers for 5 minutes,
  // and serve stale content for up to a day while a refresh is happening in the background.
  'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
  Vary: 'Accept-Encoding',
};

const FALLBACK_CACHE_HEADERS = {
  // Cache the "no data yet" response briefly so we don't hammer the DB before benchmarks land.
  'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
  Vary: 'Accept-Encoding',
};

router.get('/public/gin/benchmarks', publicGinLimiter, async (_req, res) => {
  try {
    // Try the Redis (or in-memory fallback) cache first. A hit means we
    // skip the multi-row Postgres query entirely, which is the whole point
    // of this layer — under traffic spikes the marketing endpoint stays
    // fast even when the CDN cache misses.
    const cached = await readCachedPublicBenchmark();
    if (cached) {
      const headers = cached.status === 'illustrative' ? FALLBACK_CACHE_HEADERS : PUBLIC_CACHE_HEADERS;
      res.set(headers);
      res.set('X-Benchmark-Cache', 'hit');
      return res.json(cached);
    }

    const pool = getPlatformPool();

    const verticals = Array.from(new Set(PUBLIC_METRICS.map(m => m.vertical)));
    const metricNames = Array.from(new Set(PUBLIC_METRICS.map(m => m.metric)));

    const { rows: benchmarkRows } = await pool.query(
      `SELECT DISTINCT ON (industry_vertical, metric_name)
         industry_vertical, metric_name, metric_value, sample_size,
         percentile_25, percentile_50, percentile_75, period_start, period_end, updated_at
       FROM industry_benchmarks
       WHERE industry_vertical = ANY($1::text[])
         AND metric_name = ANY($2::text[])
       ORDER BY industry_vertical, metric_name, period_end DESC, updated_at DESC`,
      [verticals, metricNames],
    );

    const benchmarkIndex = new Map<string, typeof benchmarkRows[number]>();
    for (const row of benchmarkRows) {
      benchmarkIndex.set(`${row.industry_vertical}:${row.metric_name}`, row);
    }

    let latestPeriodEnd: Date | null = null;
    const rows: PublicBenchmarkRow[] = PUBLIC_METRICS.map((spec) => {
      const row = benchmarkIndex.get(`${spec.vertical}:${spec.metric}`);
      if (!row) return null;

      const sampleSize = Number(row.sample_size) || 0;
      if (sampleSize < PUBLIC_K_ANONYMITY) return null;

      const median = row.percentile_50 != null ? Number(row.percentile_50) : Number(row.metric_value);
      const topQuartile = row.percentile_75 != null ? Number(row.percentile_75) : Number(row.metric_value);
      const cohortAvg = Number(row.metric_value);

      const periodEnd = row.period_end ? new Date(row.period_end as string) : null;
      if (periodEnd && (!latestPeriodEnd || periodEnd > latestPeriodEnd)) {
        latestPeriodEnd = periodEnd;
      }

      return {
        vertical: spec.verticalLabel,
        metric: spec.metricLabel,
        cohortAvg: formatValue(cohortAvg, spec.format),
        median: formatValue(median, spec.format),
        topQuartile: formatValue(topQuartile, spec.format),
        cohortSize: sampleSize,
      };
    }).filter((r): r is PublicBenchmarkRow => r !== null);

    if (rows.length === 0) {
      const payload: PublicBenchmarkPayload = {
        status: 'illustrative',
        snapshotAt: null,
        kAnonymity: PUBLIC_K_ANONYMITY,
        refreshCadence: 'Daily rolling window once the live aggregation pipeline accumulates enough cohorts',
        source: 'industry_benchmarks (no rows above k threshold yet)',
        rows: [],
      };
      await writeCachedPublicBenchmark(payload);
      res.set(FALLBACK_CACHE_HEADERS);
      res.set('X-Benchmark-Cache', 'miss');
      return res.json(payload);
    }

    // Promote to "live" only if (a) we have enough cohorts AND (b) marketing/legal
    // have explicitly signed off via the env gate. Without sign-off we still expose
    // real cohort numbers but keep the status pill at "preview" so the marketing
    // page does not over-claim while the statistics are awaiting approval.
    const hasEnoughCohorts = rows.length >= 3;
    const status: PublicBenchmarkPayload['status'] =
      hasEnoughCohorts && isLivePublishingApproved() ? 'live' : 'preview';

    const payload: PublicBenchmarkPayload = {
      status,
      snapshotAt: latestPeriodEnd ? (latestPeriodEnd as Date).toISOString().slice(0, 10) : null,
      kAnonymity: PUBLIC_K_ANONYMITY,
      refreshCadence: 'Daily rolling 30-day window',
      source: 'industry_benchmarks',
      rows,
    };
    await writeCachedPublicBenchmark(payload);

    res.set(PUBLIC_CACHE_HEADERS);
    res.set('X-Benchmark-Cache', 'miss');
    return res.json(payload);
  } catch (err) {
    logger.error('Failed to load public GIN benchmarks', { error: String(err) });
    // Don't cache transient errors — let the next request retry.
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({
      status: 'illustrative' as const,
      snapshotAt: null,
      kAnonymity: PUBLIC_K_ANONYMITY,
      refreshCadence: 'Daily rolling window once the live aggregation pipeline ships',
      source: 'unavailable',
      rows: [],
      error: 'benchmarks_unavailable',
    });
  }
});

// Public web survey endpoint. Customers receive an unauthenticated link
// containing a one-time `dispatch_token` that resolves to a single pending
// CSAT row scoped to a tenant + call session. We deliberately do not echo
// any tenant identifiers or PHI back to the caller — the response simply
// confirms the rating was recorded.
const publicCsatLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  message: 'CSAT submission rate limit exceeded.',
  keyGenerator: (req) => `public-csat:${req.ip ?? 'anon'}`,
});

router.post('/public/csat/:token', publicCsatLimiter, async (req, res) => {
  const token = String(req.params.token ?? '').trim();
  if (!token || token.length < 16 || token.length > 128) {
    return res.status(400).json({ error: 'invalid_token' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const scoreRaw = Number(body.score);
  if (!Number.isFinite(scoreRaw)) {
    return res.status(400).json({ error: 'invalid_score' });
  }
  const comment = typeof body.comment === 'string' ? body.comment.slice(0, 1000) : null;

  try {
    const csat = await getCsatByDispatchToken(token);
    if (!csat) return res.status(404).json({ error: 'not_found' });
    if (csat.status !== 'pending') {
      return res.status(409).json({ error: 'already_recorded', status: csat.status });
    }
    if (csat.expiresAt.getTime() <= Date.now()) {
      return res.status(410).json({ error: 'expired' });
    }

    const scale = Number(csat.scoreScale ?? 5);
    const updated = await recordCsatResponse({
      tenantId: csat.tenantId,
      csatId: csat.id,
      responseChannel: 'web',
      scoreRaw,
      scale,
      comment,
      rawResponse: JSON.stringify({ score: scoreRaw, comment }).slice(0, 1000),
    });

    if (!updated) return res.status(409).json({ error: 'race_lost' });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true });
  } catch (err) {
    logger.error('Public CSAT submission failed', { error: String(err) });
    return res.status(500).json({ error: 'submission_failed' });
  }
});

export default router;
