import { Router } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_MARKETPLACE');

router.get('/marketplace/templates', requireAuth, async (req, res) => {
  try {
    const pool = getPlatformPool();

    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const plan = typeof req.query.plan === 'string' ? req.query.plan.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : 'active';
    const agentType = typeof req.query.agent_type === 'string' ? req.query.agent_type.trim() : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';

    const parsedLimit = parseInt(String(req.query.limit ?? '50'), 10);
    const parsedPage = parseInt(String(req.query.page ?? '1'), 10);
    const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 100);
    const page = Math.max(Number.isNaN(parsedPage) ? 1 : parsedPage, 1);
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`tr.status = $${paramIdx++}`);
      params.push(status);
    }

    if (search) {
      conditions.push(`(tr.display_name ILIKE $${paramIdx} OR tr.description ILIKE $${paramIdx} OR tr.short_description ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    if (category) {
      conditions.push(`EXISTS (
        SELECT 1 FROM template_category_map tcm
        JOIN template_categories tc ON tc.id = tcm.category_id
        WHERE tcm.template_id = tr.id AND tc.name = $${paramIdx++}
      )`);
      params.push(category);
    }

    if (plan) {
      conditions.push(`EXISTS (
        SELECT 1 FROM template_entitlements te
        WHERE te.template_id = tr.id AND te.plan_tier = $${paramIdx++} AND te.enabled = TRUE
      )`);
      params.push(plan);
    }

    if (agentType) {
      conditions.push(`tr.agent_type = $${paramIdx++}`);
      params.push(agentType);
    }

    if (tag) {
      conditions.push(`tr.tags @> $${paramIdx++}::jsonb`);
      params.push(JSON.stringify([tag]));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM template_registry tr ${whereClause}`,
      params,
    );
    const total = countResult.rows[0].total;

    const queryParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT
        tr.id, tr.slug, tr.display_name, tr.description, tr.short_description,
        tr.icon_url, tr.status, tr.current_version, tr.min_plan, tr.agent_type,
        tr.default_voice, tr.default_language, tr.supported_channels,
        tr.required_tools, tr.optional_tools, tr.tags, tr.sort_order,
        tr.install_count, tr.created_at, tr.updated_at,
        COALESCE(
          (SELECT json_agg(json_build_object('name', tc.name, 'displayName', tc.display_name))
           FROM template_category_map tcm
           JOIN template_categories tc ON tc.id = tcm.category_id
           WHERE tcm.template_id = tr.id),
          '[]'
        ) AS categories
      FROM template_registry tr
      ${whereClause}
      ORDER BY tr.sort_order ASC, tr.display_name ASC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      queryParams,
    );

    res.json({
      templates: result.rows.map(formatTemplateRow),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error('Failed to list marketplace templates', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

router.get('/marketplace/templates/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPlatformPool();
    const idOrSlug = req.params.id;

    const templateResult = await pool.query(
      `SELECT
        tr.id, tr.slug, tr.display_name, tr.description, tr.short_description,
        tr.icon_url, tr.status, tr.current_version, tr.min_plan, tr.agent_type,
        tr.default_voice, tr.default_language, tr.supported_channels,
        tr.required_tools, tr.optional_tools, tr.config_schema,
        tr.tags, tr.sort_order, tr.install_count, tr.metadata,
        tr.created_at, tr.updated_at
      FROM template_registry tr
      WHERE tr.id = $1 OR tr.slug = $1`,
      [idOrSlug],
    );

    if (templateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const template = templateResult.rows[0];

    const [versionsResult, categoriesResult, changelogsResult, entitlementsResult] = await Promise.all([
      pool.query(
        `SELECT id, version, changelog, package_ref, release_notes, is_latest, published_at
         FROM template_versions
         WHERE template_id = $1
         ORDER BY published_at DESC`,
        [template.id],
      ),
      pool.query(
        `SELECT tc.name, tc.display_name, tc.description, tc.icon
         FROM template_category_map tcm
         JOIN template_categories tc ON tc.id = tcm.category_id
         WHERE tcm.template_id = $1
         ORDER BY tc.sort_order`,
        [template.id],
      ),
      pool.query(
        `SELECT id, version, change_type, summary, details, created_at
         FROM template_changelogs
         WHERE template_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [template.id],
      ),
      pool.query(
        `SELECT plan_tier, enabled
         FROM template_entitlements
         WHERE template_id = $1
         ORDER BY plan_tier`,
        [template.id],
      ),
    ]);

    res.json({
      ...formatTemplateRow(template),
      configSchema: template.config_schema,
      metadata: template.metadata,
      versions: versionsResult.rows.map((v) => ({
        id: v.id,
        version: v.version,
        changelog: v.changelog,
        packageRef: v.package_ref,
        releaseNotes: v.release_notes,
        isLatest: v.is_latest,
        publishedAt: v.published_at,
      })),
      categories: categoriesResult.rows.map((c) => ({
        name: c.name,
        displayName: c.display_name,
        description: c.description,
        icon: c.icon,
      })),
      changelogs: changelogsResult.rows.map((c) => ({
        id: c.id,
        version: c.version,
        changeType: c.change_type,
        summary: c.summary,
        details: c.details,
        createdAt: c.created_at,
      })),
      entitlements: entitlementsResult.rows.map((e) => ({
        planTier: e.plan_tier,
        enabled: e.enabled,
      })),
    });
  } catch (err) {
    logger.error('Failed to get marketplace template', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to get template' });
  }
});

router.get('/marketplace/categories', requireAuth, async (_req, res) => {
  try {
    const pool = getPlatformPool();
    const result = await pool.query(
      `SELECT
        tc.id, tc.name, tc.display_name, tc.description, tc.icon, tc.sort_order,
        COUNT(tcm.template_id)::int AS template_count
       FROM template_categories tc
       LEFT JOIN template_category_map tcm ON tcm.category_id = tc.id
       GROUP BY tc.id
       ORDER BY tc.sort_order`,
    );

    res.json({
      categories: result.rows.map((c) => ({
        id: c.id,
        name: c.name,
        displayName: c.display_name,
        description: c.description,
        icon: c.icon,
        sortOrder: c.sort_order,
        templateCount: c.template_count,
      })),
    });
  } catch (err) {
    logger.error('Failed to list categories', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

function formatTemplateRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    shortDescription: row.short_description,
    iconUrl: row.icon_url,
    status: row.status,
    currentVersion: row.current_version,
    minPlan: row.min_plan,
    agentType: row.agent_type,
    defaultVoice: row.default_voice,
    defaultLanguage: row.default_language,
    supportedChannels: row.supported_channels,
    requiredTools: row.required_tools,
    optionalTools: row.optional_tools,
    tags: row.tags,
    sortOrder: row.sort_order,
    installCount: row.install_count,
    categories: row.categories ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default router;
