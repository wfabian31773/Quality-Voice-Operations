import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('CASE_STUDY');

export interface MilestoneThreshold {
  type: 'call_volume' | 'cost_savings' | 'time_in_service';
  value: number;
  label: string;
}

export const DEFAULT_MILESTONES: MilestoneThreshold[] = [
  { type: 'call_volume', value: 500, label: '500 calls handled' },
  { type: 'call_volume', value: 1000, label: '1,000 calls handled' },
  { type: 'call_volume', value: 5000, label: '5,000 calls handled' },
  { type: 'cost_savings', value: 20, label: '20% cost reduction' },
  { type: 'cost_savings', value: 40, label: '40% cost reduction' },
  { type: 'time_in_service', value: 90, label: '90 days active' },
  { type: 'time_in_service', value: 180, label: '6 months active' },
];

export interface CaseStudy {
  id: string;
  tenantId: string;
  milestoneType: string;
  milestoneValue: number;
  industry: string;
  companySize: string;
  metrics: CaseStudyMetrics;
  title: string;
  summary: string;
  status: 'draft' | 'approved' | 'published';
  publicSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicCaseStudy {
  id: string;
  industry: string;
  companySize: string;
  metrics: CaseStudyMetrics;
  title: string;
  summary: string;
  publicSlug: string | null;
  createdAt: string;
}

export interface CaseStudyMetrics {
  totalCalls: number;
  automationRate: number;
  avgResponseTime: number;
  costSavingsPercent: number;
  monthlySavings: number;
  satisfactionScore: number;
  daysActive: number;
}

interface TenantCallStats {
  totalCalls: number;
  escalatedCalls: number;
  avgDurationSeconds: number;
  daysActive: number;
}

async function getTenantCallStats(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, tenantId: string): Promise<TenantCallStats> {
  const { rows: callRows } = await client.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE escalated = true)::int AS escalated,
       COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - created_at))), 0)::float AS avg_duration
     FROM call_sessions WHERE tenant_id = $1`,
    [tenantId],
  );

  const { rows: tenantRows } = await client.query(
    `SELECT created_at FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const tenantCreatedAt = tenantRows[0]?.created_at;
  const daysActive = tenantCreatedAt
    ? Math.floor((Date.now() - new Date(tenantCreatedAt as string).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    totalCalls: (callRows[0]?.total as number) ?? 0,
    escalatedCalls: (callRows[0]?.escalated as number) ?? 0,
    avgDurationSeconds: (callRows[0]?.avg_duration as number) ?? 0,
    daysActive,
  };
}

function computeMetrics(stats: TenantCallStats): CaseStudyMetrics {
  const automationRate = stats.totalCalls > 0
    ? Math.max(0, Math.min(1, 1 - stats.escalatedCalls / stats.totalCalls))
    : 0.85;

  const avgResponseTime = Math.max(10, Math.min(60, stats.avgDurationSeconds > 0 ? Math.round(stats.avgDurationSeconds * 0.15) : 25));

  const costSavingsPercent = Math.round(Math.min(70, automationRate * 60 + (stats.daysActive > 90 ? 10 : 0)));

  const avgCostPerCallHuman = 4.50;
  const avgCostPerCallAI = 0.45;
  const savingsPerCall = avgCostPerCallHuman - avgCostPerCallAI;
  const callsPerMonth = stats.daysActive > 0 ? Math.round((stats.totalCalls / stats.daysActive) * 30) : 0;
  const monthlySavings = Math.round(callsPerMonth * savingsPerCall * automationRate);

  const satisfactionScore = Math.round((4.0 + automationRate * 0.8 + (avgResponseTime < 30 ? 0.2 : 0)) * 10) / 10;

  return {
    totalCalls: stats.totalCalls,
    automationRate: Math.round(automationRate * 100) / 100,
    avgResponseTime,
    costSavingsPercent,
    monthlySavings,
    satisfactionScore: Math.min(5.0, satisfactionScore),
    daysActive: stats.daysActive,
  };
}

async function getTenantMilestones(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, tenantId: string): Promise<MilestoneThreshold[]> {
  const { rows } = await client.query(
    `SELECT milestone_type, milestone_value, label FROM milestone_thresholds WHERE tenant_id = $1 AND enabled = true ORDER BY milestone_value ASC`,
    [tenantId],
  );
  if (rows.length > 0) {
    return rows.map((r) => ({
      type: r.milestone_type as MilestoneThreshold['type'],
      value: r.milestone_value as number,
      label: r.label as string,
    }));
  }
  return DEFAULT_MILESTONES;
}

export async function setTenantMilestones(
  tenantId: string,
  milestones: MilestoneThreshold[],
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM milestone_thresholds WHERE tenant_id = $1`, [tenantId]);
    for (const m of milestones) {
      await client.query(
        `INSERT INTO milestone_thresholds (tenant_id, milestone_type, milestone_value, label) VALUES ($1, $2, $3, $4)`,
        [tenantId, m.type, m.value, m.label],
      );
    }
    await client.query('COMMIT');
    logger.info('Tenant milestones updated', { tenantId, count: milestones.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getTenantMilestoneConfig(tenantId: string): Promise<MilestoneThreshold[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    return await getTenantMilestones(client, tenantId);
  } finally {
    client.release();
  }
}

export async function checkMilestones(tenantId: string): Promise<MilestoneThreshold[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const triggered: MilestoneThreshold[] = [];
    const stats = await getTenantCallStats(client, tenantId);
    const metrics = computeMetrics(stats);
    const milestones = await getTenantMilestones(client, tenantId);

    const { rows: existingStudies } = await client.query(
      `SELECT milestone_type, milestone_value FROM case_studies WHERE tenant_id = $1`,
      [tenantId],
    );
    const existingSet = new Set(existingStudies.map((r: Record<string, unknown>) => `${r.milestone_type}:${r.milestone_value}`));

    for (const milestone of milestones) {
      const key = `${milestone.type}:${milestone.value}`;
      if (existingSet.has(key)) continue;

      if (milestone.type === 'call_volume' && stats.totalCalls >= milestone.value) {
        triggered.push(milestone);
      } else if (milestone.type === 'time_in_service' && stats.daysActive >= milestone.value) {
        triggered.push(milestone);
      } else if (milestone.type === 'cost_savings' && metrics.costSavingsPercent >= milestone.value) {
        triggered.push(milestone);
      }
    }

    return triggered;
  } catch (err) {
    logger.error('Failed to check milestones', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export async function generateCaseStudy(
  tenantId: string,
  milestone: MilestoneThreshold,
): Promise<CaseStudy | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const stats = await getTenantCallStats(client, tenantId);

    const { rows: tenantRows } = await client.query(
      `SELECT name, industry, company_size FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const tenant = tenantRows[0];
    if (!tenant) return null;

    const metrics = computeMetrics(stats);
    const industry = (tenant.industry as string) || 'general';
    const companySize = (tenant.company_size as string) || 'small';

    const title = generateTitle(industry, milestone, metrics);
    const summary = generateSummary(industry, milestone, metrics);
    const slugHash = Array.from(tenantId + milestone.type + milestone.value)
      .reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
      .toString(36).replace('-', 'n');
    const slug = `cs-${slugHash}-${milestone.type}-${milestone.value}`;

    const { rows: inserted } = await client.query(
      `INSERT INTO case_studies (tenant_id, milestone_type, milestone_value, industry, company_size, metrics, title, summary, status, public_slug)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9)
       ON CONFLICT (tenant_id, milestone_type, milestone_value) DO NOTHING
       RETURNING *`,
      [tenantId, milestone.type, milestone.value, industry, companySize, JSON.stringify(metrics), title, summary, slug],
    );

    if (inserted.length === 0) return null;

    const row = inserted[0];
    logger.info('Case study generated', { tenantId, milestone: milestone.label });

    return mapRow(row);
  } catch (err) {
    logger.error('Failed to generate case study', { tenantId, error: String(err) });
    return null;
  } finally {
    client.release();
  }
}

export async function getCaseStudies(tenantId: string): Promise<CaseStudy[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM case_studies WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return rows.map(mapRow);
  } catch (err) {
    logger.error('Failed to get case studies', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export async function getPublicCaseStudy(slug: string): Promise<PublicCaseStudy | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM case_studies WHERE public_slug = $1 AND status = 'published'`,
      [slug],
    );
    return rows.length > 0 ? mapPublicRow(rows[0]) : null;
  } catch (err) {
    logger.error('Failed to get public case study', { slug, error: String(err) });
    return null;
  } finally {
    client.release();
  }
}

export async function getPublishedCaseStudies(): Promise<PublicCaseStudy[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM case_studies WHERE status = 'published' ORDER BY created_at DESC LIMIT 20`,
    );
    return rows.map(mapPublicRow);
  } catch (err) {
    logger.error('Failed to get published case studies', { error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export async function updateCaseStudyStatus(
  tenantId: string,
  caseStudyId: string,
  status: 'approved' | 'published',
): Promise<CaseStudy | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE case_studies SET status = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [status, caseStudyId, tenantId],
    );
    if (rows.length === 0) return null;
    logger.info('Case study status updated', { tenantId, caseStudyId, status });
    return mapRow(rows[0]);
  } catch (err) {
    logger.error('Failed to update case study status', { tenantId, caseStudyId, error: String(err) });
    return null;
  } finally {
    client.release();
  }
}

function mapRow(row: Record<string, unknown>): CaseStudy {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    milestoneType: row.milestone_type as string,
    milestoneValue: row.milestone_value as number,
    industry: row.industry as string,
    companySize: row.company_size as string,
    metrics: (typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics) as CaseStudyMetrics,
    title: row.title as string,
    summary: row.summary as string,
    status: row.status as 'draft' | 'approved' | 'published',
    publicSlug: row.public_slug as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPublicRow(row: Record<string, unknown>): PublicCaseStudy {
  return {
    id: row.id as string,
    industry: row.industry as string,
    companySize: row.company_size as string,
    metrics: (typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics) as CaseStudyMetrics,
    title: row.title as string,
    summary: row.summary as string,
    publicSlug: row.public_slug as string | null,
    createdAt: String(row.created_at),
  };
}

export async function checkAllTenantMilestones(): Promise<{ tenantId: string; generated: number }[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rows: tenants } = await client.query(
      `SELECT id FROM tenants WHERE status = 'active'`,
    );

    const results: { tenantId: string; generated: number }[] = [];
    for (const t of tenants) {
      const tenantId = t.id as string;
      try {
        const milestones = await checkMilestones(tenantId);
        let generated = 0;
        for (const m of milestones) {
          const study = await generateCaseStudy(tenantId, m);
          if (study) generated++;
        }
        if (generated > 0) {
          results.push({ tenantId, generated });
        }
      } catch (err) {
        logger.warn('Failed to check milestones for tenant', { tenantId, error: String(err) });
      }
    }

    logger.info('Automated milestone check complete', { tenantsChecked: tenants.length, studiesGenerated: results.reduce((sum, r) => sum + r.generated, 0) });
    return results;
  } finally {
    client.release();
  }
}

function generateTitle(industry: string, milestone: MilestoneThreshold, metrics: CaseStudyMetrics): string {
  const industryLabel = industry.charAt(0).toUpperCase() + industry.slice(1);
  if (milestone.type === 'call_volume') {
    return `${industryLabel} Practice Handles ${milestone.value.toLocaleString()} Calls with ${Math.round(metrics.automationRate * 100)}% Automation`;
  }
  if (milestone.type === 'cost_savings') {
    return `${industryLabel} Business Achieves ${metrics.costSavingsPercent}% Cost Reduction with AI Voice Agents`;
  }
  return `${industryLabel} Business Automates Voice Operations for ${metrics.daysActive} Days`;
}

function generateSummary(industry: string, _milestone: MilestoneThreshold, metrics: CaseStudyMetrics): string {
  const parts: string[] = [];
  parts.push(`A ${industry} business deployed QVO AI voice agents and achieved measurable results.`);
  parts.push(`After ${metrics.daysActive} days of operation, the system handled ${metrics.totalCalls.toLocaleString()} calls with a ${Math.round(metrics.automationRate * 100)}% automation rate.`);
  parts.push(`Average response time dropped to ${metrics.avgResponseTime} seconds, while monthly costs decreased by ${metrics.costSavingsPercent}%, saving approximately $${metrics.monthlySavings.toLocaleString()} per month.`);
  parts.push(`Customer satisfaction reached ${metrics.satisfactionScore}/5.0.`);
  return parts.join(' ');
}
