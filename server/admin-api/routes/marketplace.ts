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

router.get('/marketplace/installations', requireAuth, async (req, res) => {
  try {
    const pool = getPlatformPool();
    const tenantId = req.user!.tenantId;

    const result = await pool.query(
      `SELECT
        tai.id, tai.tenant_id, tai.template_id, tai.installed_version,
        tai.status, tai.config, tai.agent_id, tai.installed_at, tai.updated_at,
        tr.display_name AS template_name, tr.short_description AS template_description,
        tr.icon_url AS template_icon, tr.current_version AS latest_version,
        tr.supported_channels, tr.agent_type, tr.slug AS template_slug,
        COALESCE(
          (SELECT json_agg(json_build_object('name', tc.name, 'displayName', tc.display_name))
           FROM template_category_map tcm
           JOIN template_categories tc ON tc.id = tcm.category_id
           WHERE tcm.template_id = tr.id),
          '[]'
        ) AS categories
      FROM tenant_agent_installations tai
      JOIN template_registry tr ON tr.id = tai.template_id
      WHERE tai.tenant_id = $1
      ORDER BY tai.installed_at DESC`,
      [tenantId],
    );

    res.json({
      installations: result.rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        templateId: row.template_id,
        installedVersion: row.installed_version,
        status: row.status,
        config: row.config,
        agentId: row.agent_id,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
        templateName: row.template_name,
        templateDescription: row.template_description,
        templateIcon: row.template_icon,
        latestVersion: row.latest_version,
        supportedChannels: row.supported_channels,
        agentType: row.agent_type,
        templateSlug: row.template_slug,
        categories: row.categories,
        updateAvailable: row.installed_version !== row.latest_version,
      })),
    });
  } catch (err) {
    logger.error('Failed to list installations', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list installations' });
  }
});

router.post('/marketplace/templates/:id/install', requireAuth, async (req, res) => {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const tenantId = req.user!.tenantId;
    const templateId = req.params.id;
    const { agentName, greeting, phoneNumberId } = req.body || {};

    const templateResult = await client.query(
      `SELECT id, current_version, display_name, agent_type, default_voice, min_plan
       FROM template_registry WHERE (id = $1 OR slug = $1) AND status = 'active'`,
      [templateId],
    );

    if (templateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found or not active' });
    }

    const template = templateResult.rows[0];

    const existingResult = await client.query(
      `SELECT id FROM tenant_agent_installations WHERE tenant_id = $1 AND template_id = $2`,
      [tenantId, template.id],
    );

    if (existingResult.rows.length > 0) {
      return res.status(409).json({ error: 'Template already installed' });
    }

    if (phoneNumberId) {
      const phoneCheck = await client.query(
        `SELECT id FROM phone_numbers WHERE id = $1 AND tenant_id = $2`,
        [phoneNumberId, tenantId],
      );
      if (phoneCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or unauthorized phone number' });
      }
    }

    await client.query('BEGIN');

    const agentResult = await client.query(
      `INSERT INTO agents (tenant_id, name, type, voice, status, welcome_greeting)
       VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING id`,
      [tenantId, agentName || template.display_name, template.agent_type === 'outbound' ? 'outbound-sales' : 'general', template.default_voice, greeting || ''],
    );
    const agentId = agentResult.rows[0].id;

    const installResult = await client.query(
      `INSERT INTO tenant_agent_installations (tenant_id, template_id, installed_version, status, config, agent_id)
       VALUES ($1, $2, $3, 'active', $4, $5)
       RETURNING id`,
      [tenantId, template.id, template.current_version, JSON.stringify({ phoneNumberId: phoneNumberId || null }), agentId],
    );

    await client.query(
      `UPDATE template_registry SET install_count = install_count + 1 WHERE id = $1`,
      [template.id],
    );

    await client.query(
      `INSERT INTO template_install_events (tenant_id, template_id, event_type, version)
       VALUES ($1, $2, 'installed', $3)`,
      [tenantId, template.id, template.current_version],
    );

    await client.query('COMMIT');

    res.json({
      installationId: installResult.rows[0].id,
      agentId,
      message: 'Template installed successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to install template', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to install template' });
  } finally {
    client.release();
  }
});
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

export default router;
