import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';
import {
  CONVERSION_STAGE,
  type ConversionStage as SharedConversionStage,
} from '../../shared/analytics/conversionStages';

const logger = createLogger('WEBSITE_CONVERSION');

// Re-exported for backwards-compatibility with callers that import
// `ConversionStage` from this module. The single source of truth
// for the union members lives in
// `shared/analytics/conversionStages.ts`.
export type ConversionStage = SharedConversionStage;

// Funnel report ordering — a *subset* of `ALL_CONVERSION_STAGES`
// (e.g. `demo_completed`, `trial_started` are tracked but not part
// of the canonical website-funnel waterfall in the admin report).
// `demo_requested` (Book a Demo form submit) and
// `roi_report_requested` (ROI calculator email request) sit between
// CTA click and signup as mid-funnel intent signals — see Task #1230.
// Keep in sync with `getWebsiteFunnel` below.
export const WEBSITE_FUNNEL_STAGES: ConversionStage[] = [
  CONVERSION_STAGE.PAGE_VIEW,
  CONVERSION_STAGE.CTA_CLICK,
  CONVERSION_STAGE.DEMO_STARTED,
  CONVERSION_STAGE.DEMO_REQUESTED,
  CONVERSION_STAGE.ROI_REPORT_REQUESTED,
  CONVERSION_STAGE.SIGNUP_STARTED,
  CONVERSION_STAGE.SIGNUP_COMPLETED,
  CONVERSION_STAGE.PAID,
];

export interface ConversionEvent {
  id: string;
  visitorId: string;
  stage: ConversionStage;
  landingPage: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WebsiteFunnelMetrics {
  stages: Array<{
    stage: string;
    count: number;
    conversionRate: number;
    dropOffRate: number;
  }>;
  overallConversionRate: number;
  totalVisitors: number;
  byLandingPage: Array<{
    landingPage: string;
    visitors: number;
    signups: number;
    paid: number;
    conversionRate: number;
  }>;
  bySource: Array<{
    source: string;
    visitors: number;
    signups: number;
    paid: number;
    conversionRate: number;
  }>;
}

export async function getVisitorAttribution(
  visitorId: string,
): Promise<{ landingPage: string; utmSource: string | null; utmMedium: string | null; utmCampaign: string | null } | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT landing_page, utm_source, utm_medium, utm_campaign
       FROM website_conversion_events
       WHERE visitor_id = $1
       ORDER BY created_at ASC
       LIMIT 1`,
      [visitorId],
    );
    if (rows.length === 0) return null;
    return {
      landingPage: rows[0].landing_page as string,
      utmSource: rows[0].utm_source as string | null,
      utmMedium: rows[0].utm_medium as string | null,
      utmCampaign: rows[0].utm_campaign as string | null,
    };
  } finally {
    client.release();
  }
}

export async function recordConversionEvent(
  visitorId: string,
  stage: ConversionStage,
  landingPage: string,
  utm?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string },
  metadata?: Record<string, unknown>,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO website_conversion_events (visitor_id, stage, landing_page, utm_source, utm_medium, utm_campaign, utm_content, utm_term, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        visitorId,
        stage,
        landingPage,
        utm?.source ?? null,
        utm?.medium ?? null,
        utm?.campaign ?? null,
        utm?.content ?? null,
        utm?.term ?? null,
        JSON.stringify(metadata ?? {}),
      ],
    );
    logger.info('Conversion event recorded', { visitorId, stage, landingPage });
  } catch (err) {
    logger.error('Failed to record conversion event', { visitorId, stage, error: String(err) });
  } finally {
    client.release();
  }
}

export async function getWebsiteFunnel(from: Date, to: Date): Promise<WebsiteFunnelMetrics> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows: stageRows } = await client.query(
      `SELECT stage, COUNT(DISTINCT visitor_id)::int AS count
       FROM website_conversion_events
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY stage`,
      [from, to],
    );

    const stageCounts = new Map<string, number>();
    for (const r of stageRows) {
      stageCounts.set(r.stage as string, r.count as number);
    }

    const totalVisitors = stageCounts.get(CONVERSION_STAGE.PAGE_VIEW) ?? 0;

    const stages = WEBSITE_FUNNEL_STAGES.map((stage, idx) => {
      const count = stageCounts.get(stage) ?? 0;
      const prevCount = idx === 0 ? totalVisitors : (stageCounts.get(WEBSITE_FUNNEL_STAGES[idx - 1]) ?? 0);
      const dropOffRate = prevCount > 0 ? Math.max(0, 1 - count / prevCount) : 0;
      const conversionRate = totalVisitors > 0 ? count / totalVisitors : 0;
      return { stage, count, conversionRate, dropOffRate };
    });

    const paidCount = stageCounts.get(CONVERSION_STAGE.PAID) ?? 0;
    const overallConversionRate = totalVisitors > 0 ? paidCount / totalVisitors : 0;

    // Stage names below are interpolated from the canonical
    // `CONVERSION_STAGE` constants (not user input) so they stay in
    // lockstep with the writers and the funnel-report ordering. The
    // surrounding query still uses parameterized bindings ($1, $2)
    // for the date range.
    const { rows: landingRows } = await client.query(
      `SELECT
         landing_page,
         COUNT(DISTINCT visitor_id) FILTER (WHERE stage = '${CONVERSION_STAGE.PAGE_VIEW}')::int AS visitors,
         COUNT(DISTINCT visitor_id) FILTER (WHERE stage = '${CONVERSION_STAGE.SIGNUP_COMPLETED}')::int AS signups,
         COUNT(DISTINCT visitor_id) FILTER (WHERE stage = '${CONVERSION_STAGE.PAID}')::int AS paid
       FROM website_conversion_events
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY landing_page
       ORDER BY visitors DESC
       LIMIT 20`,
      [from, to],
    );

    const byLandingPage = landingRows.map((r: Record<string, unknown>) => ({
      landingPage: r.landing_page as string,
      visitors: (r.visitors as number) || 0,
      signups: (r.signups as number) || 0,
      paid: (r.paid as number) || 0,
      conversionRate: ((r.visitors as number) || 0) > 0
        ? ((r.paid as number) || 0) / ((r.visitors as number) || 0)
        : 0,
    }));

    const { rows: sourceRows } = await client.query(
      `SELECT
         COALESCE(utm_source, 'direct') AS source,
         COUNT(DISTINCT visitor_id) FILTER (WHERE stage = '${CONVERSION_STAGE.PAGE_VIEW}')::int AS visitors,
         COUNT(DISTINCT visitor_id) FILTER (WHERE stage = '${CONVERSION_STAGE.SIGNUP_COMPLETED}')::int AS signups,
         COUNT(DISTINCT visitor_id) FILTER (WHERE stage = '${CONVERSION_STAGE.PAID}')::int AS paid
       FROM website_conversion_events
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY COALESCE(utm_source, 'direct')
       ORDER BY visitors DESC
       LIMIT 20`,
      [from, to],
    );

    const bySource = sourceRows.map((r: Record<string, unknown>) => ({
      source: r.source as string,
      visitors: (r.visitors as number) || 0,
      signups: (r.signups as number) || 0,
      paid: (r.paid as number) || 0,
      conversionRate: ((r.visitors as number) || 0) > 0
        ? ((r.paid as number) || 0) / ((r.visitors as number) || 0)
        : 0,
    }));

    return { stages, overallConversionRate, totalVisitors, byLandingPage, bySource };
  } catch (err) {
    logger.error('Failed to get website funnel', { error: String(err) });
    return { stages: [], overallConversionRate: 0, totalVisitors: 0, byLandingPage: [], bySource: [] };
  } finally {
    client.release();
  }
}

export async function getConversionTrends(
  from: Date,
  to: Date,
): Promise<Array<{ date: string; stages: Record<string, number> }>> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT
         DATE(created_at) AS date,
         stage,
         COUNT(DISTINCT visitor_id)::int AS count
       FROM website_conversion_events
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY DATE(created_at), stage
       ORDER BY date`,
      [from, to],
    );

    const byDate = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const date = String(r.date).slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, {});
      byDate.get(date)![r.stage as string] = r.count as number;
    }

    return Array.from(byDate.entries()).map(([date, stages]) => ({ date, stages }));
  } catch (err) {
    logger.error('Failed to get conversion trends', { error: String(err) });
    return [];
  } finally {
    client.release();
  }
}
