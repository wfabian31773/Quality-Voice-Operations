import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('GIN_BENCHMARKING');

export interface IndustryBenchmark {
  id: string;
  industryVertical: string;
  metricName: string;
  metricValue: number;
  sampleSize: number;
  percentile25: number | null;
  percentile50: number | null;
  percentile75: number | null;
  periodStart: string;
  periodEnd: string;
}

export interface TenantBenchmarkComparison {
  metricName: string;
  tenantValue: number;
  industryAvg: number;
  percentile25: number | null;
  percentile50: number | null;
  percentile75: number | null;
  percentileRank: string;
  sampleSize: number;
}

export async function getIndustryBenchmarks(
  industryVertical: string,
  options: { limit?: number } = {},
): Promise<IndustryBenchmark[]> {
  const pool = getPlatformPool();
  const limit = Math.min(options.limit ?? 50, 100);

  const { rows } = await pool.query(
    `SELECT * FROM industry_benchmarks
     WHERE industry_vertical = $1
     ORDER BY period_end DESC, metric_name
     LIMIT $2`,
    [industryVertical, limit],
  );

  return rows.map(mapBenchmarkRow);
}

export async function getTenantBenchmarkComparison(
  tenantId: string,
): Promise<{ industry: string; comparisons: TenantBenchmarkComparison[] }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const { rows: agentRows } = await client.query(
      `SELECT DISTINCT type FROM agents WHERE tenant_id = $1 AND status = 'deployed'`,
      [tenantId],
    );

    const industry = detectTenantIndustry(agentRows.map(r => r.type as string));

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const { rows: callMetrics } = await client.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL)::int AS escalated,
         COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0), 0)::float AS avg_duration
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, thirtyDaysAgo, now],
    );

    const { rows: qualityRows } = await client.query(
      `SELECT COALESCE(AVG(score), 0)::float AS avg_quality
       FROM call_quality_scores
       WHERE tenant_id = $1 AND scored_at >= $2 AND scored_at < $3`,
      [tenantId, thirtyDaysAgo, now],
    );

    const { rows: conversionRows } = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE stage = 'booking_confirmed')::int AS bookings,
         COUNT(*) FILTER (WHERE stage = 'call_started')::int AS started
       FROM conversion_events
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, thirtyDaysAgo, now],
    ).catch(() => ({ rows: [{ bookings: 0, started: 0 }] }));

    const cm = callMetrics[0] || {};
    const totalCalls = (cm.total_calls as number) || 0;
    const completionRate = totalCalls > 0 ? ((cm.completed as number) || 0) / totalCalls : 0;
    const escalationRate = totalCalls > 0 ? ((cm.escalated as number) || 0) / totalCalls : 0;
    const avgDuration = cm.avg_duration as number || 0;
    const avgQuality = qualityRows[0]?.avg_quality as number || 0;
    const conv = conversionRows[0] || {};
    const bookingRate = ((conv.started as number) || 0) > 0
      ? ((conv.bookings as number) || 0) / ((conv.started as number) || 1)
      : 0;

    const tenantMetrics: Record<string, number> = {
      booking_conversion_rate: bookingRate,
      avg_call_duration_seconds: avgDuration,
      avg_quality_score: avgQuality,
      call_completion_rate: completionRate,
      escalation_rate: escalationRate,
    };

    const { rows: benchmarks } = await client.query(
      `SELECT * FROM industry_benchmarks
       WHERE industry_vertical = $1
       AND period_end >= (CURRENT_DATE - INTERVAL '60 days')
       ORDER BY period_end DESC`,
      [industry],
    );

    const latestBenchmarks = new Map<string, Record<string, unknown>>();
    for (const b of benchmarks) {
      const metric = b.metric_name as string;
      if (!latestBenchmarks.has(metric)) {
        latestBenchmarks.set(metric, b);
      }
    }

    const comparisons: TenantBenchmarkComparison[] = [];
    for (const [metricName, tenantValue] of Object.entries(tenantMetrics)) {
      const benchmark = latestBenchmarks.get(metricName);
      if (!benchmark) continue;

      const industryAvg = parseFloat(String(benchmark.metric_value ?? 0));
      const p25 = benchmark.percentile_25 ? parseFloat(String(benchmark.percentile_25)) : null;
      const p50 = benchmark.percentile_50 ? parseFloat(String(benchmark.percentile_50)) : null;
      const p75 = benchmark.percentile_75 ? parseFloat(String(benchmark.percentile_75)) : null;

      let percentileRank = 'average';
      if (p75 !== null && tenantValue >= p75) percentileRank = 'top_25';
      else if (p50 !== null && tenantValue >= p50) percentileRank = 'above_average';
      else if (p25 !== null && tenantValue < p25) percentileRank = 'below_average';

      if (metricName === 'escalation_rate') {
        if (p25 !== null && tenantValue <= p25) percentileRank = 'top_25';
        else if (p50 !== null && tenantValue <= p50) percentileRank = 'above_average';
        else if (p75 !== null && tenantValue > p75) percentileRank = 'below_average';
      }

      comparisons.push({
        metricName,
        tenantValue,
        industryAvg,
        percentile25: p25,
        percentile50: p50,
        percentile75: p75,
        percentileRank,
        sampleSize: (benchmark.sample_size as number) || 0,
      });
    }

    return { industry, comparisons };
  } finally {
    client.release();
  }
}

export async function getAllIndustryVerticals(): Promise<string[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT DISTINCT industry_vertical FROM industry_benchmarks ORDER BY industry_vertical`,
  );
  return rows.map(r => r.industry_vertical as string);
}

function detectTenantIndustry(agentTypes: string[]): string {
  const typeMap: Record<string, string> = {
    'dental': 'dental',
    'medical-after-hours': 'medical',
    'home-services': 'home_services',
    'property-management': 'property_management',
    'legal': 'legal',
  };

  for (const t of agentTypes) {
    if (typeMap[t]) return typeMap[t];
  }
  return 'general';
}

function mapBenchmarkRow(row: Record<string, unknown>): IndustryBenchmark {
  return {
    id: row.id as string,
    industryVertical: row.industry_vertical as string,
    metricName: row.metric_name as string,
    metricValue: parseFloat(String(row.metric_value ?? 0)),
    sampleSize: (row.sample_size as number) ?? 0,
    percentile25: row.percentile_25 ? parseFloat(String(row.percentile_25)) : null,
    percentile50: row.percentile_50 ? parseFloat(String(row.percentile_50)) : null,
    percentile75: row.percentile_75 ? parseFloat(String(row.percentile_75)) : null,
    periodStart: String(row.period_start).slice(0, 10),
    periodEnd: String(row.period_end).slice(0, 10),
  };
}
