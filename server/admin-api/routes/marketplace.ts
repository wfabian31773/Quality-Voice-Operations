import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole, requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import {
  getTemplate,
  installTemplate,
  listInstallations,
  updateInstallation,
} from '../../../platform/marketplace/InstallationService';
import { checkEntitlement } from '../../../platform/marketplace/EntitlementService';
import {
  getChecklistState,
  markStepComplete,
  markStepIncomplete,
} from '../../../platform/marketplace/ChecklistService';
import {
  buildCustomizationSchema,
  validateCustomizationUpdate,
} from '../../../platform/marketplace/CustomizationSchema';
import {
  isNewerVersion,
  getUpgradeType,
  isMajorUpgrade,
  validateVersionFormat,
  runPrePublicationValidation,
  validateUpgradeCompatibility,
} from '../../../platform/agent-templates/versioningService';

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

    const isPlatformAdmin = req.user?.isPlatformAdmin === true;

    const [versionsResult, categoriesResult, changelogsResult, entitlementsResult] = await Promise.all([
      pool.query(
        isPlatformAdmin
          ? `SELECT id, version, changelog, package_ref, release_notes, is_latest, status, published_at
             FROM template_versions
             WHERE template_id = $1
             ORDER BY published_at DESC`
          : `SELECT id, version, changelog, release_notes, is_latest, status, published_at
             FROM template_versions
             WHERE template_id = $1 AND status = 'published'
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
        ...(isPlatformAdmin ? { packageRef: v.package_ref } : {}),
        releaseNotes: v.release_notes,
        isLatest: v.is_latest,
        status: v.status,
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

router.get('/marketplace/updates', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: installations } = await client.query(
      `SELECT
        tai.id AS installation_id,
        tai.template_id,
        tai.installed_version,
        tai.config,
        tr.slug AS template_slug,
        tr.display_name AS template_name,
        tr.current_version,
        tr.config_schema
       FROM tenant_agent_installations tai
       JOIN template_registry tr ON tr.id = tai.template_id
       WHERE tai.tenant_id = $1 AND tai.status = 'active'`,
      [tenantId],
    );

    await client.query('COMMIT');

    const updates = [];
    for (const inst of installations) {
      if (!isNewerVersion(inst.installed_version, inst.current_version)) continue;

      const upgradeType = getUpgradeType(inst.installed_version, inst.current_version);
      if (!upgradeType) continue;

      const changelogResult = await pool.query(
        `SELECT version, change_type, summary, details, created_at
         FROM template_changelogs
         WHERE template_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [inst.template_id],
      );

      const relevantChangelogs = changelogResult.rows.filter(
        (c) => isNewerVersion(inst.installed_version, c.version as string),
      );

      updates.push({
        installationId: inst.installation_id,
        templateId: inst.template_id,
        templateSlug: inst.template_slug,
        templateName: inst.template_name,
        installedVersion: inst.installed_version,
        availableVersion: inst.current_version,
        upgradeType,
        isMajor: isMajorUpgrade(inst.installed_version, inst.current_version),
        changelog: relevantChangelogs.map((c) => ({
          version: c.version,
          changeType: c.change_type,
          summary: c.summary,
          details: c.details,
          createdAt: c.created_at,
        })),
        requiresConfirmation: isMajorUpgrade(inst.installed_version, inst.current_version),
      });
    }

    return res.json({ updates });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to check for updates', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to check for updates' });
  } finally {
    client.release();
  }
});

router.post('/marketplace/installations/:id/upgrade', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { confirmed } = req.body as { confirmed?: boolean };
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: instRows } = await client.query(
      `SELECT tai.*, tr.current_version, tr.config_schema, tr.slug, tr.display_name,
              tr.required_tools
       FROM tenant_agent_installations tai
       JOIN template_registry tr ON tr.id = tai.template_id
       WHERE tai.id = $1 AND tai.tenant_id = $2`,
      [id, tenantId],
    );

    if (instRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Installation not found' });
    }

    const installation = instRows[0];
    const targetVersion = installation.current_version as string;
    const installedVersion = installation.installed_version as string;

    if (!isNewerVersion(installedVersion, targetVersion)) {
      await client.query('COMMIT');
      return res.status(400).json({ error: 'Already on the latest version' });
    }

    const isMajor = isMajorUpgrade(installedVersion, targetVersion);
    if (isMajor && !confirmed) {
      await client.query('COMMIT');
      return res.status(400).json({
        error: 'Major version upgrade requires explicit confirmation',
        requiresConfirmation: true,
        upgradeType: 'major',
        from: installedVersion,
        to: targetVersion,
      });
    }

    const compatibility = validateUpgradeCompatibility(
      installedVersion,
      targetVersion,
      (installation.config ?? {}) as Record<string, unknown>,
      (installation.config_schema ?? {}) as Record<string, unknown>,
    );

    if (!compatibility.valid) {
      await client.query('COMMIT');
      return res.status(400).json({
        error: 'Upgrade compatibility check failed',
        validation: compatibility,
      });
    }

    await client.query(
      `UPDATE tenant_agent_installations
       SET installed_version = $1,
           rollback_version = $2,
           previous_config = config,
           status = 'active',
           upgraded_at = NOW(),
           updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4`,
      [targetVersion, installedVersion, id, tenantId],
    );

    await client.query(
      `INSERT INTO template_install_events (tenant_id, template_id, event_type, version, metadata)
       VALUES ($1, $2, 'upgraded', $3, $4)`,
      [tenantId, installation.template_id, targetVersion, JSON.stringify({
        previousVersion: installedVersion,
        upgradeType: getUpgradeType(installedVersion, targetVersion),
        userId,
      })],
    );

    await client.query('COMMIT');

    logger.info('Template installation upgraded', {
      tenantId,
      installationId: id,
      from: installedVersion,
      to: targetVersion,
    });

    return res.json({
      success: true,
      installation: {
        id,
        templateId: installation.template_id,
        templateSlug: installation.slug,
        previousVersion: installedVersion,
        newVersion: targetVersion,
        upgradeType: getUpgradeType(installedVersion, targetVersion),
        compatibility,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to upgrade installation', { tenantId, installationId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to upgrade installation' });
  } finally {
    client.release();
  }
});

router.post('/platform/templates/:id/versions', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { version, changelog, releaseNotes, packageRef } = req.body as {
    version?: string;
    changelog?: string;
    releaseNotes?: string;
    packageRef?: string;
  };

  if (!version || !validateVersionFormat(version)) {
    return res.status(400).json({ error: 'Valid semantic version required (e.g. 1.2.3)' });
  }

  const pool = getPlatformPool();

  try {
    const { rows: templateRows } = await pool.query(
      `SELECT id, slug FROM template_registry WHERE id = $1`,
      [id],
    );

    if (templateRows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { rows: existing } = await pool.query(
      `SELECT id FROM template_versions WHERE template_id = $1 AND version = $2`,
      [id, version],
    );

    if (existing.length > 0) {
      return res.status(409).json({ error: `Version ${version} already exists for this template` });
    }

    const { rows } = await pool.query(
      `INSERT INTO template_versions (template_id, version, changelog, release_notes, package_ref, status, is_latest, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', FALSE, $6)
       RETURNING *`,
      [id, version, changelog ?? '', releaseNotes ?? '', packageRef ?? '', req.user!.userId],
    );

    logger.info('Draft template version created', { templateId: id, version });

    return res.status(201).json({
      version: {
        id: rows[0].id,
        templateId: rows[0].template_id,
        version: rows[0].version,
        changelog: rows[0].changelog,
        releaseNotes: rows[0].release_notes,
        packageRef: rows[0].package_ref,
        status: rows[0].status,
        isLatest: rows[0].is_latest,
        publishedAt: rows[0].published_at,
      },
    });
  } catch (err) {
    logger.error('Failed to create template version', { templateId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to create template version' });
  }
});

router.post('/platform/templates/:id/versions/:versionId/validate', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, versionId } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows: templateRows } = await pool.query(
      `SELECT id, slug, description, required_tools, config_schema
       FROM template_registry WHERE id = $1`,
      [id],
    );

    if (templateRows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { rows: versionRows } = await pool.query(
      `SELECT id, version, changelog FROM template_versions WHERE id = $1 AND template_id = $2`,
      [versionId, id],
    );

    if (versionRows.length === 0) {
      return res.status(404).json({ error: 'Version not found' });
    }

    const template = templateRows[0];
    const versionData = versionRows[0];

    const result = runPrePublicationValidation(
      {
        slug: template.slug as string,
        requiredTools: (template.required_tools ?? []) as string[],
        configSchema: (template.config_schema ?? {}) as Record<string, unknown>,
        description: template.description as string,
      },
      {
        version: versionData.version as string,
        changelog: versionData.changelog as string,
      },
    );

    return res.json({ validation: result });
  } catch (err) {
    logger.error('Failed to validate template version', { templateId: id, versionId, error: String(err) });
    return res.status(500).json({ error: 'Failed to validate template version' });
  }
});

router.post('/platform/templates/:id/versions/:versionId/publish', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, versionId } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: templateRows } = await client.query(
      `SELECT id, slug, description, required_tools, config_schema
       FROM template_registry WHERE id = $1`,
      [id],
    );

    if (templateRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Template not found' });
    }

    const { rows: versionRows } = await client.query(
      `SELECT id, version, changelog, status FROM template_versions WHERE id = $1 AND template_id = $2`,
      [versionId, id],
    );

    if (versionRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Version not found' });
    }

    if (versionRows[0].status === 'published') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Version is already published' });
    }

    const template = templateRows[0];
    const versionData = versionRows[0];

    const validation = runPrePublicationValidation(
      {
        slug: template.slug as string,
        requiredTools: (template.required_tools ?? []) as string[],
        configSchema: (template.config_schema ?? {}) as Record<string, unknown>,
        description: template.description as string,
      },
      {
        version: versionData.version as string,
        changelog: versionData.changelog as string,
      },
    );

    if (!validation.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Pre-publication validation failed',
        validation,
      });
    }

    await client.query(
      `UPDATE template_versions SET is_latest = FALSE WHERE template_id = $1 AND is_latest = TRUE`,
      [id],
    );

    await client.query(
      `UPDATE template_versions
       SET status = 'published', is_latest = TRUE, published_at = NOW()
       WHERE id = $1`,
      [versionId],
    );

    await client.query(
      `UPDATE template_registry
       SET current_version = $1, updated_at = NOW()
       WHERE id = $2`,
      [versionData.version, id],
    );

    await client.query('COMMIT');

    logger.info('Template version published', {
      templateId: id,
      templateSlug: template.slug,
      version: versionData.version,
      publishedBy: req.user!.userId,
    });

    return res.json({
      success: true,
      version: versionData.version,
      templateSlug: template.slug,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to publish template version', { templateId: id, versionId, error: String(err) });
    return res.status(500).json({ error: 'Failed to publish template version' });
  } finally {
    client.release();
  }
});

router.patch('/platform/templates/:id/versions/:versionId/deprecate', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id, versionId } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows: versionRows } = await pool.query(
      `SELECT id, version, status, is_latest FROM template_versions WHERE id = $1 AND template_id = $2`,
      [versionId, id],
    );

    if (versionRows.length === 0) {
      return res.status(404).json({ error: 'Version not found' });
    }

    if (versionRows[0].is_latest) {
      return res.status(400).json({ error: 'Cannot deprecate the current latest version' });
    }

    await pool.query(
      `UPDATE template_versions SET status = 'deprecated' WHERE id = $1`,
      [versionId],
    );

    logger.info('Template version deprecated', {
      templateId: id,
      versionId,
      version: versionRows[0].version,
    });

    return res.json({ success: true, version: versionRows[0].version, status: 'deprecated' });
  } catch (err) {
    logger.error('Failed to deprecate template version', { templateId: id, versionId, error: String(err) });
    return res.status(500).json({ error: 'Failed to deprecate template version' });
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

router.get('/marketplace/templates/:id/compatibility', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const template = await getTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const result = await checkEntitlement(tenantId, {
      minPlan: template.min_plan,
      requiredIntegrations: template.required_integrations,
    });

    return res.json({
      compatible: result.allowed,
      errors: result.errors,
      warnings: result.warnings,
      plan: result.plan,
      agentCount: result.agentCount,
      maxAgents: result.maxAgents,
    });
  } catch (err) {
    logger.error('Failed to check compatibility', { tenantId, templateId: req.params.id, error: String(err) });
    return res.status(500).json({ error: 'Failed to check compatibility' });
  }
});

router.post('/marketplace/templates/:id/install', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId, userId } = req.user!;
  const templateId = req.params.id;
  const body = req.body as Record<string, unknown>;

  const name = body.name as string | undefined;
  const welcomeGreeting = body.welcomeGreeting as string | undefined;
  const escalationConfig = body.escalationConfig as Record<string, unknown> | undefined;
  const metadata = body.metadata as Record<string, unknown> | undefined;

  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }
  if (welcomeGreeting !== undefined && typeof welcomeGreeting !== 'string') {
    return res.status(400).json({ error: 'welcomeGreeting must be a string' });
  }

  try {
    const result = await installTemplate({
      tenantId,
      templateId,
      userId,
      name: name?.trim(),
      welcomeGreeting,
      escalationConfig,
      metadata,
    });

    if (!result.success) {
      return res.status(result.errors && result.errors.length > 1 ? 422 : 400).json({
        error: result.error,
        errors: result.errors,
      });
    }

    writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: req.user!.role,
      action: 'marketplace.template_installed',
      resourceType: 'installation',
      resourceId: result.installation!.id,
      changes: {
        templateId,
        agentId: result.installation!.agentId,
        templateVersion: result.installation!.templateVersion,
      },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.status(201).json({ installation: result.installation });
  } catch (err) {
    logger.error('Install endpoint failed', { tenantId, templateId, error: String(err) });
    return res.status(500).json({ error: 'Failed to install template' });
  }
});

router.get('/marketplace/installations', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const installations = await listInstallations(tenantId);
    return res.json({ installations });
  } catch (err) {
    logger.error('Failed to list installations', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list installations' });
  }
});

router.patch('/marketplace/installations/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId, userId } = req.user!;
  const installationId = req.params.id;
  const body = req.body as Record<string, unknown>;
  const pool = getPlatformPool();

  const name = body.name as string | undefined;
  const welcomeGreeting = body.welcomeGreeting as string | undefined;
  const escalationConfig = body.escalationConfig as Record<string, unknown> | undefined;

  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }
  if (welcomeGreeting !== undefined && typeof welcomeGreeting !== 'string') {
    return res.status(400).json({ error: 'welcomeGreeting must be a string' });
  }

  if (name === undefined && welcomeGreeting === undefined && escalationConfig === undefined) {
    return res.status(400).json({ error: 'No valid fields to update. Supported: name, welcomeGreeting, escalationConfig' });
  }

  try {
    const { rows: instRows } = await pool.query(
      `SELECT tr.config_schema
       FROM tenant_agent_installations tai
       JOIN template_registry tr ON tr.id = tai.template_id
       WHERE tai.id = $1 AND tai.tenant_id = $2 AND tai.status = 'active'`,
      [installationId, tenantId],
    );

    if (instRows.length > 0) {
      const configSchema = instRows[0].config_schema as Record<string, unknown> | null;
      const normalized: Record<string, unknown> = {};
      if (name !== undefined) normalized.name = name;
      if (welcomeGreeting !== undefined) normalized.welcome_greeting = welcomeGreeting;
      if (escalationConfig !== undefined) normalized.escalation_config = escalationConfig;

      const validation = validateCustomizationUpdate(configSchema, normalized);
      if (!validation.valid) {
        const errors: string[] = [];
        if (validation.rejectedFields.length > 0) {
          errors.push(`Restricted fields: ${validation.rejectedFields.join(', ')}`);
        }
        if (validation.valueErrors.length > 0) {
          errors.push(...validation.valueErrors);
        }
        return res.status(validation.rejectedFields.length > 0 ? 403 : 400).json({
          error: errors[0] ?? 'Validation failed',
          rejectedFields: validation.rejectedFields,
          valueErrors: validation.valueErrors,
        });
      }
    }

    const result = await updateInstallation(tenantId, installationId, {
      name: name?.trim(),
      welcomeGreeting,
      escalationConfig,
    });

    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }

    writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: req.user!.role,
      action: 'marketplace.installation_updated',
      resourceType: 'installation',
      resourceId: installationId,
      changes: { name, welcomeGreeting, escalationConfig },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ installation: result.installation });
  } catch (err) {
    logger.error('Failed to update installation', { tenantId, installationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update installation' });
  }
});

router.get('/marketplace/installations/:id/checklist', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const installationId = req.params.id;

  try {
    const checklist = await getChecklistState(tenantId, installationId);
    if (!checklist) {
      return res.status(404).json({ error: 'Installation not found' });
    }
    return res.json({ checklist });
  } catch (err) {
    logger.error('Failed to get checklist', { tenantId, installationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get checklist' });
  }
});

router.patch('/marketplace/installations/:id/checklist', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const installationId = req.params.id;
  const { stepKey, completed } = req.body as { stepKey?: string; completed?: boolean };

  if (!stepKey || typeof stepKey !== 'string') {
    return res.status(400).json({ error: 'stepKey is required' });
  }

  try {
    const result = completed === false
      ? await markStepIncomplete(tenantId, installationId, stepKey)
      : await markStepComplete(tenantId, installationId, stepKey);

    if (!result.success) {
      return res.status(result.error === 'Installation not found' ? 404 : 400).json({ error: result.error });
    }

    return res.json({ checklist: result.checklist });
  } catch (err) {
    logger.error('Failed to update checklist', { tenantId, installationId, stepKey, error: String(err) });
    return res.status(500).json({ error: 'Failed to update checklist' });
  }
});

router.get('/marketplace/installations/:id/customization-schema', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const installationId = req.params.id;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT tai.id, tai.agent_id, tai.template_id, tr.slug AS template_slug,
              tr.config_schema, a.type AS agent_type,
              a.name, a.voice, a.model, a.temperature, a.welcome_greeting,
              a.system_prompt, a.escalation_config, a.metadata, a.status AS agent_status
       FROM tenant_agent_installations tai
       JOIN template_registry tr ON tr.id = tai.template_id
       JOIN agents a ON a.id = tai.agent_id AND a.tenant_id = tai.tenant_id
       WHERE tai.id = $1 AND tai.tenant_id = $2 AND tai.status = 'active'`,
      [installationId, tenantId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Installation not found' });
    }

    const configSchema = rows[0].config_schema as Record<string, unknown> | null;
    const schema = buildCustomizationSchema(configSchema);
    const agentMeta = (rows[0].metadata as Record<string, unknown>) ?? {};

    return res.json({
      schema,
      currentValues: {
        name: rows[0].name,
        voice: rows[0].voice,
        model: rows[0].model,
        temperature: rows[0].temperature,
        welcome_greeting: rows[0].welcome_greeting,
        system_prompt: rows[0].system_prompt,
        escalation_config: rows[0].escalation_config,
        type: rows[0].agent_type,
        status: rows[0].agent_status,
        business_details: agentMeta.business_details ?? '',
        working_hours: agentMeta.working_hours ?? null,
        enabled_tools: agentMeta.enabled_tools ?? null,
        knowledge_base: agentMeta.knowledge_base ?? null,
      },
      agentId: rows[0].agent_id,
      agentType: rows[0].agent_type,
      templateSlug: rows[0].template_slug,
    });
  } catch (err) {
    logger.error('Failed to get customization schema', { tenantId, installationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get customization schema' });
  }
});

router.patch('/marketplace/installations/:id/customize', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId, userId } = req.user!;
  const installationId = req.params.id;
  const body = req.body as Record<string, unknown>;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT tai.id, tai.agent_id, tr.config_schema, a.metadata AS agent_metadata
       FROM tenant_agent_installations tai
       JOIN template_registry tr ON tr.id = tai.template_id
       JOIN agents a ON a.id = tai.agent_id AND a.tenant_id = tai.tenant_id
       WHERE tai.id = $1 AND tai.tenant_id = $2 AND tai.status = 'active'`,
      [installationId, tenantId],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Installation not found' });
    }

    const configSchema = rows[0].config_schema as Record<string, unknown> | null;
    const agentId = rows[0].agent_id as string;

    const validation = validateCustomizationUpdate(configSchema, body);
    if (!validation.valid) {
      await client.query('COMMIT');
      const errors: string[] = [];
      if (validation.rejectedFields.length > 0) {
        errors.push(`Restricted fields: ${validation.rejectedFields.join(', ')}`);
      }
      if (validation.valueErrors.length > 0) {
        errors.push(...validation.valueErrors);
      }
      return res.status(validation.rejectedFields.length > 0 ? 403 : 400).json({
        error: errors[0] ?? 'Validation failed',
        rejectedFields: validation.rejectedFields,
        valueErrors: validation.valueErrors,
      });
    }

    const agentColumnFields = ['name', 'welcome_greeting', 'voice', 'temperature', 'escalation_config'];
    const metadataFields = ['business_details', 'working_hours', 'enabled_tools', 'knowledge_base'];
    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [agentId, tenantId];

    for (const key of agentColumnFields) {
      if (key in body) {
        const val = key === 'escalation_config' ? JSON.stringify(body[key]) : body[key];
        values.push(val);
        updates.push(`${key} = $${values.length}`);
      }
    }

    const metaUpdates: Record<string, unknown> = {};
    let hasMetaUpdates = false;
    for (const key of metadataFields) {
      if (key in body) {
        metaUpdates[key] = body[key];
        hasMetaUpdates = true;
      }
    }

    if (hasMetaUpdates) {
      const existingMeta = (rows[0].agent_metadata as Record<string, unknown>) ?? {};
      const newMeta = { ...existingMeta, ...metaUpdates };
      values.push(JSON.stringify(newMeta));
      updates.push(`metadata = $${values.length}`);
    }

    if (updates.length > 1) {
      await client.query(
        `UPDATE agents SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2`,
        values,
      );
    }

    await client.query(
      `UPDATE tenant_agent_installations SET customization_overrides = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(body), installationId, tenantId],
    );

    await client.query('COMMIT');

    writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: req.user!.role,
      action: 'marketplace.installation_customized',
      resourceType: 'installation',
      resourceId: installationId,
      changes: body,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to customize installation', { tenantId, installationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to customize installation' });
  } finally {
    client.release();
  }
});

router.post('/marketplace/installations/:id/assign-phone', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId, userId } = req.user!;
  const installationId = req.params.id;
  const { phoneNumberId } = req.body as { phoneNumberId?: string };
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: instRows } = await client.query(
      `SELECT tai.id, tai.agent_id
       FROM tenant_agent_installations tai
       WHERE tai.id = $1 AND tai.tenant_id = $2 AND tai.status = 'active'`,
      [installationId, tenantId],
    );

    if (instRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Installation not found' });
    }

    const agentId = instRows[0].agent_id as string;

    let selectedPhoneId = phoneNumberId;
    if (!selectedPhoneId) {
      const { rows: phoneRows } = await client.query(
        `SELECT pn.id FROM phone_numbers pn
         WHERE pn.tenant_id = $1 AND pn.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM number_routing nr WHERE nr.phone_number_id = pn.id AND nr.is_active = TRUE
         )
         ORDER BY pn.created_at ASC
         LIMIT 1`,
        [tenantId],
      );

      if (phoneRows.length === 0) {
        await client.query('COMMIT');
        return res.status(400).json({ error: 'No available phone numbers. Please purchase or assign a number first.' });
      }

      selectedPhoneId = phoneRows[0].id as string;
    } else {
      const { rows: phoneRows } = await client.query(
        `SELECT id FROM phone_numbers WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
        [selectedPhoneId, tenantId],
      );
      if (phoneRows.length === 0) {
        await client.query('COMMIT');
        return res.status(404).json({ error: 'Phone number not found or not active' });
      }
    }

    await client.query(
      `UPDATE number_routing SET is_active = FALSE
       WHERE phone_number_id = $1 AND tenant_id = $2`,
      [selectedPhoneId, tenantId],
    );

    const { rows: existingRoute } = await client.query(
      `SELECT id FROM number_routing
       WHERE phone_number_id = $1 AND agent_id = $2 AND tenant_id = $3`,
      [selectedPhoneId, agentId, tenantId],
    );

    if (existingRoute.length > 0) {
      await client.query(
        `UPDATE number_routing SET is_active = TRUE, priority = 1, updated_at = NOW()
         WHERE phone_number_id = $1 AND agent_id = $2 AND tenant_id = $3`,
        [selectedPhoneId, agentId, tenantId],
      );
    } else {
      await client.query(
        `INSERT INTO number_routing (phone_number_id, agent_id, priority, is_active, tenant_id)
         VALUES ($1, $2, 1, TRUE, $3)`,
        [selectedPhoneId, agentId, tenantId],
      );
    }

    await client.query('COMMIT');

    const { rows: phoneInfo } = await pool.query(
      `SELECT id, phone_number, friendly_name FROM phone_numbers WHERE id = $1`,
      [selectedPhoneId],
    );

    return res.json({
      success: true,
      phoneNumber: phoneInfo[0] ?? { id: selectedPhoneId },
      agentId,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to assign phone', { tenantId, installationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to assign phone number' });
  } finally {
    client.release();
  }
});

router.post('/marketplace/installations/:id/enable-widget', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const installationId = req.params.id;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: instRows } = await client.query(
      `SELECT tai.id, tai.agent_id
       FROM tenant_agent_installations tai
       WHERE tai.id = $1 AND tai.tenant_id = $2 AND tai.status = 'active'`,
      [installationId, tenantId],
    );

    if (instRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Installation not found' });
    }

    const agentId = instRows[0].agent_id as string;

    const { rows: existing } = await client.query(
      `SELECT id, enabled FROM widget_configs WHERE tenant_id = $1`,
      [tenantId],
    );

    if (existing.length > 0) {
      await client.query(
        `UPDATE widget_configs SET agent_id = $1, enabled = TRUE, updated_at = NOW()
         WHERE tenant_id = $2`,
        [agentId, tenantId],
      );
    } else {
      await client.query(
        `INSERT INTO widget_configs (tenant_id, agent_id, enabled, greeting, primary_color, text_chat_enabled, voice_enabled)
         VALUES ($1, $2, TRUE, 'Hello! How can I help you today?', '#6366f1', TRUE, TRUE)`,
        [tenantId, agentId],
      );
    }

    await client.query('COMMIT');

    return res.json({ success: true, agentId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to enable widget', { tenantId, installationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to enable widget' });
  } finally {
    client.release();
  }
});

router.post('/marketplace/installations/:id/publish-agent', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId, userId } = req.user!;
  const installationId = req.params.id;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: instRows } = await client.query(
      `SELECT tai.id, tai.agent_id, a.status
       FROM tenant_agent_installations tai
       JOIN agents a ON a.id = tai.agent_id AND a.tenant_id = tai.tenant_id
       WHERE tai.id = $1 AND tai.tenant_id = $2 AND tai.status = 'active'`,
      [installationId, tenantId],
    );

    if (instRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Installation not found' });
    }

    const agentId = instRows[0].agent_id as string;

    await client.query(
      `UPDATE agents SET status = 'active', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId],
    );

    await client.query('COMMIT');

    writeAuditLog({
      tenantId,
      actorUserId: userId,
      actorRole: req.user!.role,
      action: 'marketplace.agent_published',
      resourceType: 'installation',
      resourceId: installationId,
      changes: { agentId, status: 'active' },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ success: true, agentId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to publish agent', { tenantId, installationId, error: String(err) });
    return res.status(500).json({ error: 'Failed to publish agent' });
  } finally {
    client.release();
  }
});

export default router;
