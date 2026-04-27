import { Router } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';

const logger = createLogger('PUBLIC_GIN_API');
const router = Router();

const PUBLIC_K_ANONYMITY = Number(process.env.GIN_PUBLIC_K_ANONYMITY ?? 8);

interface PublicMetricSpec {
  metric: string;
  vertical: string;
  verticalLabel: string;
  metricLabel: string;
  format: 'percent' | 'duration' | 'score';
}

const PUBLIC_METRICS: PublicMetricSpec[] = [
  { vertical: 'medical', verticalLabel: 'Healthcare', metric: 'call_completion_rate', metricLabel: 'After-hours answer rate', format: 'percent' },
  { vertical: 'dental', verticalLabel: 'Dental', metric: 'booking_conversion_rate', metricLabel: 'Booking conversion', format: 'percent' },
  { vertical: 'home_services', verticalLabel: 'Field service', metric: 'avg_call_duration_seconds', metricLabel: 'Average call duration', format: 'duration' },
  { vertical: 'property_management', verticalLabel: 'Real estate', metric: 'booking_conversion_rate', metricLabel: 'Lead-to-tour rate', format: 'percent' },
  { vertical: 'legal', verticalLabel: 'Legal', metric: 'avg_quality_score', metricLabel: 'Quality score', format: 'score' },
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
    return raw <= 1 ? raw.toFixed(2) : raw.toFixed(1);
  }
  return String(raw);
}

const publicGinLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  message: 'GIN public benchmark rate limit exceeded.',
  keyGenerator: (req) => `public-gin:${req.ip ?? 'anon'}`,
});

router.get('/public/gin/benchmarks', publicGinLimiter, async (_req, res) => {
  try {
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
    const rows = PUBLIC_METRICS.map((spec) => {
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
    }).filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length === 0) {
      return res.json({
        status: 'illustrative' as const,
        snapshotAt: null,
        kAnonymity: PUBLIC_K_ANONYMITY,
        refreshCadence: 'Daily rolling window once the live aggregation pipeline accumulates enough cohorts',
        source: 'industry_benchmarks (no rows above k threshold yet)',
        rows: [],
      });
    }

    const status = rows.length >= 3 ? ('live' as const) : ('preview' as const);

    return res.json({
      status,
      snapshotAt: latestPeriodEnd ? (latestPeriodEnd as Date).toISOString().slice(0, 10) : null,
      kAnonymity: PUBLIC_K_ANONYMITY,
      refreshCadence: 'Daily rolling 30-day window',
      source: 'industry_benchmarks',
      rows,
    });
  } catch (err) {
    logger.error('Failed to load public GIN benchmarks', { error: String(err) });
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

export default router;
