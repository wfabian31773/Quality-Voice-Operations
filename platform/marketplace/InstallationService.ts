import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { checkEntitlement } from './EntitlementService';
import { generateEmbedding } from '../knowledge/embeddingService';
import type { TenantId } from '../core/types';

const logger = createLogger('INSTALLATION_SERVICE');

export interface RegistryTemplate {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  status: string;
  current_version: string;
  min_plan: string;
  agent_type: string;
  default_voice: string;
  required_tools: unknown[];
  optional_tools: unknown[];
  metadata: Record<string, unknown>;
  required_integrations: string[];
}

export interface InstallRequest {
  tenantId: TenantId;
  templateId: string;
  userId: string;
  name?: string;
  welcomeGreeting?: string;
  escalationConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface InstallResult {
  success: boolean;
  error?: string;
  errors?: string[];
  installation?: {
    id: string;
    agentId: string;
    templateId: string;
    templateVersion: string;
    status: string;
    knowledgeSeeded?: boolean;
  };
}

export async function getTemplate(templateId: string): Promise<RegistryTemplate | null> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT id, slug, display_name, description, status, current_version, min_plan,
            agent_type, default_voice, required_tools, optional_tools, metadata
     FROM template_registry WHERE id = $1 OR slug = $1`,
    [templateId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const meta = (row.metadata as Record<string, unknown>) ?? {};
  return {
    ...row,
    required_integrations: Array.isArray(meta.required_integrations)
      ? (meta.required_integrations as string[])
      : [],
  } as RegistryTemplate;
}

export async function installTemplate(request: InstallRequest): Promise<InstallResult> {
  const { tenantId, templateId, userId, name, welcomeGreeting, escalationConfig, metadata } = request;

  const template = await getTemplate(templateId);
  if (!template) {
    return { success: false, error: 'Template not found' };
  }

  if (template.status !== 'active') {
    return { success: false, error: 'Template is not available for installation' };
  }

  const entitlement = await checkEntitlement(tenantId, {
    minPlan: template.min_plan,
    requiredIntegrations: template.required_integrations,
  });

  if (!entitlement.allowed) {
    return { success: false, error: entitlement.errors[0], errors: entitlement.errors };
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: existingInstalls } = await client.query(
      `SELECT id FROM tenant_agent_installations
       WHERE tenant_id = $1 AND template_id = $2 AND status = 'active'`,
      [tenantId, templateId],
    );

    if (existingInstalls.length > 0) {
      await client.query('COMMIT');
      return { success: false, error: 'This template is already installed. You can update the existing installation.' };
    }

    const agentName = name ?? template.display_name;
    const voice = template.default_voice ?? 'sage';
    const model = 'gpt-4o-realtime-preview';
    const temperature = 0.8;
    const tools: unknown[] = [];
    const greeting = welcomeGreeting ?? null;
    const escalation = escalationConfig ?? {};
    const agentMetadata = {
      ...(metadata ?? {}),
      installedFromTemplate: template.slug,
      templateId: template.id,
    };

    const agentType = template.agent_type === 'outbound' ? 'outbound-sales' : 'answering-service';

    const { rows: agentRows } = await client.query(
      `INSERT INTO agents (tenant_id, name, type, voice, model, temperature, tools, welcome_greeting, escalation_config, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        tenantId,
        agentName,
        agentType,
        voice,
        model,
        temperature,
        JSON.stringify(tools),
        greeting,
        JSON.stringify(escalation),
        JSON.stringify(agentMetadata),
      ],
    );

    const agent = agentRows[0];

    const installConfig = {
      name: agentName,
      welcomeGreeting: greeting,
      escalationConfig: escalation,
      ...(metadata ?? {}),
    };

    const { rows: installRows } = await client.query(
      `INSERT INTO tenant_agent_installations (tenant_id, template_id, agent_id, installed_version, status, config, installed_by)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)
       RETURNING *`,
      [
        tenantId,
        template.id,
        agent.id,
        template.current_version,
        JSON.stringify(installConfig),
        userId,
      ],
    );

    await client.query(
      `UPDATE template_registry SET install_count = install_count + 1 WHERE id = $1`,
      [template.id],
    );

    await client.query(
      `INSERT INTO template_install_events (tenant_id, template_id, event_type, version, metadata)
       VALUES ($1, $2, 'installed', $3, $4)`,
      [tenantId, template.id, template.current_version, JSON.stringify({ agentId: agent.id, userId })],
    );

    await client.query('COMMIT');

    const installation = installRows[0];
    logger.info('Template installed successfully', {
      tenantId,
      templateId: template.id,
      templateSlug: template.slug,
      agentId: agent.id,
      installationId: installation.id,
    });

    let knowledgeSeeded = false;
    try {
      await seedStarterKnowledgePack(tenantId, template.slug);
      knowledgeSeeded = true;
    } catch (seedErr) {
      logger.warn('Failed to seed starter knowledge pack — installation succeeded but knowledge pack was not loaded', {
        tenantId,
        templateSlug: template.slug,
        error: String(seedErr),
      });
    }

    return {
      success: true,
      installation: {
        id: installation.id as string,
        agentId: agent.id as string,
        templateId: template.id,
        templateVersion: template.current_version,
        status: 'active',
        knowledgeSeeded,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Template installation failed', { tenantId, templateId, error: String(err) });
    return { success: false, error: 'Installation failed due to an internal error' };
  } finally {
    client.release();
  }
}

export async function listInstallations(tenantId: TenantId): Promise<unknown[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT tai.id, tai.tenant_id, tai.template_id, tai.agent_id, tai.installed_version,
              tai.status, tai.config, tai.installed_by, tai.installed_at, tai.updated_at,
              tr.slug AS template_slug, tr.display_name AS template_name,
              tr.current_version AS latest_version,
              a.name AS agent_name, a.status AS agent_status, a.type AS agent_type
       FROM tenant_agent_installations tai
       JOIN template_registry tr ON tr.id = tai.template_id
       LEFT JOIN agents a ON a.id = tai.agent_id AND a.tenant_id = tai.tenant_id
       WHERE tai.tenant_id = $1
       ORDER BY tai.installed_at DESC`,
      [tenantId],
    );

    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to list installations', { tenantId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

export interface UpdateInstallationRequest {
  name?: string;
  welcomeGreeting?: string;
  escalationConfig?: Record<string, unknown>;
}

const TEMPLATE_TO_VERTICALS: Record<string, string[]> = {
  'home-services': ['hvac', 'plumbing'],
  'dental': ['dental'],
  'medical-after-hours': ['medical-after-hours'],
  'property-management': ['property-management'],
  'legal': ['legal'],
  'restaurants': ['restaurants'],
  'real-estate': ['real-estate'],
  'insurance': ['insurance'],
};

async function seedStarterKnowledgePack(tenantId: TenantId, templateSlug: string): Promise<void> {
  const verticalIds = TEMPLATE_TO_VERTICALS[templateSlug];
  if (!verticalIds || verticalIds.length === 0) {
    logger.info('No starter knowledge pack for template', { templateSlug });
    return;
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const placeholders = verticalIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: articles } = await client.query(
      `SELECT title, content, category_type FROM vertical_starter_knowledge
       WHERE vertical_id IN (${placeholders})
       ORDER BY sort_order`,
      verticalIds,
    );

    if (articles.length === 0) {
      await client.query('COMMIT');
      return;
    }

    let seededCount = 0;
    for (const article of articles) {
      const { rows: existing } = await client.query(
        `SELECT id FROM knowledge_articles WHERE tenant_id = $1 AND title = $2`,
        [tenantId, article.title],
      );

      if (existing.length > 0) continue;

      let embedding: number[] = [];
      try {
        embedding = await generateEmbedding(`${article.title}\n\n${article.content}`);
      } catch (embErr) {
        logger.warn('Embedding generation failed for starter article, storing without embedding', {
          tenantId,
          articleTitle: article.title,
          error: String(embErr),
        });
      }

      await client.query(
        `INSERT INTO knowledge_articles (tenant_id, title, content, category, metadata, embedding, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
        [
          tenantId,
          article.title,
          article.content,
          article.category_type,
          JSON.stringify({ source: 'starter_knowledge_pack', verticalIds }),
          JSON.stringify(embedding),
        ],
      );
      seededCount++;
    }

    await client.query('COMMIT');
    logger.info('Starter knowledge pack seeded', {
      tenantId,
      templateSlug,
      verticalIds,
      articlesSeeded: seededCount,
      totalAvailable: articles.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to seed starter knowledge pack', {
      tenantId,
      templateSlug,
      error: String(err),
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function updateInstallation(
  tenantId: TenantId,
  installationId: string,
  updates: UpdateInstallationRequest,
): Promise<{ success: boolean; error?: string; installation?: unknown }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: installRows } = await client.query(
      `SELECT id, agent_id, config
       FROM tenant_agent_installations
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [installationId, tenantId],
    );

    if (installRows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Installation not found' };
    }

    const install = installRows[0];
    const agentId = install.agent_id as string;

    if (agentId) {
      const agentUpdates: string[] = ['updated_at = NOW()'];
      const agentValues: unknown[] = [agentId, tenantId];

      if (updates.name !== undefined) {
        agentValues.push(updates.name);
        agentUpdates.push(`name = $${agentValues.length}`);
      }
      if (updates.welcomeGreeting !== undefined) {
        agentValues.push(updates.welcomeGreeting);
        agentUpdates.push(`welcome_greeting = $${agentValues.length}`);
      }
      if (updates.escalationConfig !== undefined) {
        agentValues.push(JSON.stringify(updates.escalationConfig));
        agentUpdates.push(`escalation_config = $${agentValues.length}`);
      }

      if (agentUpdates.length > 1) {
        await client.query(
          `UPDATE agents SET ${agentUpdates.join(', ')} WHERE id = $1 AND tenant_id = $2`,
          agentValues,
        );
      }
    }

    const existingConfig = (install.config as Record<string, unknown>) ?? {};
    const newConfig = { ...existingConfig, ...updates };
    await client.query(
      `UPDATE tenant_agent_installations SET config = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(newConfig), installationId, tenantId],
    );

    const { rows: resultRows } = await client.query(
      `SELECT tai.id, tai.tenant_id, tai.template_id, tai.agent_id, tai.installed_version,
              tai.status, tai.config, tai.installed_at, tai.updated_at,
              a.name AS agent_name, a.status AS agent_status
       FROM tenant_agent_installations tai
       LEFT JOIN agents a ON a.id = tai.agent_id AND a.tenant_id = tai.tenant_id
       WHERE tai.id = $1 AND tai.tenant_id = $2`,
      [installationId, tenantId],
    );

    await client.query('COMMIT');

    return { success: true, installation: resultRows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to update installation', { tenantId, installationId, error: String(err) });
    return { success: false, error: 'Failed to update installation' };
  } finally {
    client.release();
  }
}
