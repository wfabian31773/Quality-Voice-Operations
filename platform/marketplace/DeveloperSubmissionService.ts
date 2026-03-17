import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';
import { validateVersionFormat } from '../agent-templates/versioningService';

const logger = createLogger('DEVELOPER_SUBMISSIONS');

export interface SubmissionInput {
  developerId: string;
  developerName: string;
  developerEmail: string;
  packageName: string;
  packageSlug: string;
  marketplaceCategory: string;
  description: string;
  shortDescription?: string;
  version?: string;
  priceModel?: string;
  priceCents?: number;
  manifest: Record<string, unknown>;
}

export interface Submission {
  id: string;
  developerId: string;
  developerName: string;
  developerEmail: string;
  packageName: string;
  packageSlug: string;
  marketplaceCategory: string;
  description: string;
  shortDescription: string | null;
  version: string;
  priceModel: string;
  priceCents: number;
  manifest: Record<string, unknown>;
  status: string;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSubmission(input: SubmissionInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.packageName || input.packageName.trim().length < 3) {
    errors.push('Package name must be at least 3 characters');
  }

  if (!input.packageSlug || !/^[a-z0-9-]+$/.test(input.packageSlug)) {
    errors.push('Package slug must contain only lowercase letters, numbers, and hyphens');
  }

  if (!input.description || input.description.trim().length < 20) {
    errors.push('Description must be at least 20 characters');
  }

  const validCategories = ['vertical_agent', 'workflow_package', 'integration_connector', 'prompt_pack', 'analytics_pack'];
  if (!validCategories.includes(input.marketplaceCategory)) {
    errors.push(`Category must be one of: ${validCategories.join(', ')}`);
  }

  if (input.version && !validateVersionFormat(input.version)) {
    errors.push('Version must follow semantic versioning (e.g., 1.0.0)');
  }

  const validPriceModels = ['free', 'one_time', 'monthly_subscription', 'usage_based'];
  if (input.priceModel && !validPriceModels.includes(input.priceModel)) {
    errors.push(`Price model must be one of: ${validPriceModels.join(', ')}`);
  }

  if (input.priceModel !== 'free' && input.priceCents !== undefined && input.priceCents < 0) {
    errors.push('Price must be zero or positive');
  }

  if (!input.developerEmail || !input.developerEmail.includes('@')) {
    errors.push('Valid developer email is required');
  }

  if (!input.manifest || typeof input.manifest !== 'object') {
    errors.push('Package manifest is required');
  }

  if (!input.manifest.supportedChannels && input.marketplaceCategory === 'vertical_agent') {
    warnings.push('No supported channels specified — recommended for agent templates');
  }

  if (!input.manifest.requiredTools) {
    warnings.push('No required tools specified');
  }

  return { valid: errors.length === 0, errors, warnings };
}

export async function createSubmission(input: SubmissionInput): Promise<{
  success: boolean;
  error?: string;
  submission?: Submission;
  validation?: ValidationResult;
}> {
  const validation = validateSubmission(input);
  if (!validation.valid) {
    return { success: false, error: validation.errors[0], validation };
  }

  const pool = getPlatformPool();

  try {
    const { rows: existing } = await pool.query(
      `SELECT id FROM developer_submissions WHERE package_slug = $1 AND status NOT IN ('rejected')`,
      [input.packageSlug],
    );

    if (existing.length > 0) {
      return { success: false, error: 'A package with this slug already exists or is pending review' };
    }

    const { rows } = await pool.query(
      `INSERT INTO developer_submissions
         (developer_id, developer_name, developer_email, package_name, package_slug,
          marketplace_category, description, short_description, version, price_model, price_cents, manifest, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'submitted')
       RETURNING *`,
      [
        input.developerId,
        input.developerName,
        input.developerEmail,
        input.packageName,
        input.packageSlug,
        input.marketplaceCategory,
        input.description,
        input.shortDescription ?? null,
        input.version ?? '1.0.0',
        input.priceModel ?? 'free',
        input.priceCents ?? 0,
        JSON.stringify(input.manifest),
      ],
    );

    logger.info('Developer submission created', {
      submissionId: rows[0].id,
      developerId: input.developerId,
      packageSlug: input.packageSlug,
    });

    return { success: true, submission: formatSubmission(rows[0]), validation };
  } catch (err) {
    logger.error('Failed to create submission', { error: String(err) });
    return { success: false, error: 'Failed to create submission' };
  }
}

export async function listSubmissions(options: {
  developerId?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ submissions: Submission[]; total: number }> {
  const pool = getPlatformPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options.developerId) {
    conditions.push(`developer_id = $${idx++}`);
    params.push(options.developerId);
  }
  if (options.status) {
    conditions.push(`status = $${idx++}`);
    params.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  const [countResult, dataResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM developer_submissions ${where}`, params),
    pool.query(
      `SELECT * FROM developer_submissions ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    ),
  ]);

  return {
    submissions: dataResult.rows.map(formatSubmission),
    total: countResult.rows[0].total as number,
  };
}

export async function reviewSubmission(
  submissionId: string,
  reviewerId: string,
  decision: 'approved' | 'rejected',
  reviewNotes?: string,
): Promise<{ success: boolean; error?: string; submission?: Submission }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: subRows } = await client.query(
      `SELECT * FROM developer_submissions WHERE id = $1 AND status IN ('submitted', 'in_review')`,
      [submissionId],
    );

    if (subRows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Submission not found or not in reviewable state' };
    }

    const submission = subRows[0];

    await client.query(
      `UPDATE developer_submissions
       SET status = $1, review_notes = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4`,
      [decision, reviewNotes ?? null, reviewerId, submissionId],
    );

    let templateId: string | null = null;

    if (decision === 'approved') {
      const manifest = submission.manifest as Record<string, unknown>;

      const { rows: templateRows } = await client.query(
        `INSERT INTO template_registry
           (slug, display_name, description, short_description, status, current_version,
            min_plan, agent_type, default_voice, default_language, supported_channels,
            required_tools, optional_tools, config_schema, tags, marketplace_category,
            price_model, price_cents, developer_id, developer_name, sort_order, metadata)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 99, $20)
         ON CONFLICT (slug) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           short_description = EXCLUDED.short_description,
           current_version = EXCLUDED.current_version,
           marketplace_category = EXCLUDED.marketplace_category,
           price_model = EXCLUDED.price_model,
           price_cents = EXCLUDED.price_cents,
           developer_id = EXCLUDED.developer_id,
           developer_name = EXCLUDED.developer_name,
           updated_at = NOW()
         RETURNING id`,
        [
          submission.package_slug,
          submission.package_name,
          submission.description,
          submission.short_description,
          submission.version ?? '1.0.0',
          (manifest.minPlan as string) ?? 'starter',
          (manifest.agentType as string) ?? 'inbound',
          (manifest.defaultVoice as string) ?? 'sage',
          (manifest.defaultLanguage as string) ?? 'en',
          JSON.stringify((manifest.supportedChannels as string[]) ?? ['voice']),
          JSON.stringify((manifest.requiredTools as string[]) ?? []),
          JSON.stringify((manifest.optionalTools as string[]) ?? []),
          JSON.stringify(manifest.configSchema ?? {}),
          JSON.stringify((manifest.tags as string[]) ?? []),
          submission.marketplace_category,
          submission.price_model,
          submission.price_cents,
          submission.developer_id,
          submission.developer_name,
          JSON.stringify({ submissionId, ...((manifest.metadata as Record<string, unknown>) ?? {}) }),
        ],
      );

      templateId = templateRows[0].id as string;

      await client.query(
        `UPDATE developer_submissions SET template_id = $1, status = 'published', updated_at = NOW() WHERE id = $2`,
        [templateId, submissionId],
      );
    }

    await client.query('COMMIT');

    const { rows: updated } = await pool.query(
      `SELECT * FROM developer_submissions WHERE id = $1`,
      [submissionId],
    );

    logger.info('Submission reviewed', { submissionId, decision, reviewerId, templateId });

    return { success: true, submission: formatSubmission(updated[0]) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to review submission', { submissionId, error: String(err) });
    return { success: false, error: 'Failed to review submission' };
  } finally {
    client.release();
  }
}

export async function getDeveloperStats(developerId: string): Promise<{
  totalSubmissions: number;
  publishedCount: number;
  totalInstalls: number;
  totalRevenue: number;
  avgRating: number;
}> {
  const pool = getPlatformPool();

  const [subResult, installResult, revenueResult, ratingResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'published')::int AS published
       FROM developer_submissions WHERE developer_id = $1`,
      [developerId],
    ),
    pool.query(
      `SELECT COALESCE(SUM(tr.install_count), 0)::int AS total_installs
       FROM template_registry tr WHERE tr.developer_id = $1`,
      [developerId],
    ),
    pool.query(
      `SELECT COALESCE(SUM(developer_share_cents), 0)::int AS total_revenue
       FROM marketplace_revenue_events WHERE developer_id = $1`,
      [developerId],
    ),
    pool.query(
      `SELECT COALESCE(AVG(tr.avg_rating), 0)::numeric(3,2) AS avg_rating
       FROM template_registry tr WHERE tr.developer_id = $1 AND tr.review_count > 0`,
      [developerId],
    ),
  ]);

  return {
    totalSubmissions: subResult.rows[0].total as number,
    publishedCount: subResult.rows[0].published as number,
    totalInstalls: installResult.rows[0].total_installs as number,
    totalRevenue: revenueResult.rows[0].total_revenue as number,
    avgRating: parseFloat(ratingResult.rows[0].avg_rating as string),
  };
}

function formatSubmission(row: Record<string, unknown>): Submission {
  return {
    id: row.id as string,
    developerId: row.developer_id as string,
    developerName: row.developer_name as string,
    developerEmail: row.developer_email as string,
    packageName: row.package_name as string,
    packageSlug: row.package_slug as string,
    marketplaceCategory: row.marketplace_category as string,
    description: row.description as string,
    shortDescription: row.short_description as string | null,
    version: row.version as string,
    priceModel: row.price_model as string,
    priceCents: row.price_cents as number,
    manifest: row.manifest as Record<string, unknown>,
    status: row.status as string,
    reviewNotes: row.review_notes as string | null,
    reviewedBy: row.reviewed_by as string | null,
    reviewedAt: row.reviewed_at as string | null,
    templateId: row.template_id as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
