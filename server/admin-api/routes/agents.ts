import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import { getTemplatePermissions, getAllKnownTools } from '../../../platform/agent-templates/toolPermissions';

const router = Router();
const logger = createLogger('ADMIN_AGENTS');

const MAX_SYSTEM_PROMPT_LENGTH = 32_000;

const VALID_AGENT_TYPES = new Set([
  'general', 'answering-service', 'medical-after-hours', 'outbound-scheduling',
  'appointment-confirmation', 'custom', 'dental', 'property-management',
  'home-services', 'legal', 'customer-support', 'outbound-sales',
  'technical-support', 'collections',
]);

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

function validateToolsShape(tools: unknown): string | null {
  if (!Array.isArray(tools)) return 'tools must be an array';
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (typeof tool !== 'object' || tool === null) return `tools[${i}] must be an object`;
    if (typeof (tool as Record<string, unknown>).name !== 'string') return `tools[${i}].name must be a string`;
  }
  return null;
}

function validateAgentInput(body: Record<string, unknown>, isCreate: boolean): string | null {
  if (isCreate && !body.name) return 'name is required';

  if (body.type !== undefined && !VALID_AGENT_TYPES.has(body.type as string)) {
    return `type must be one of: ${[...VALID_AGENT_TYPES].join(', ')}`;
  }

  if (body.system_prompt !== undefined) {
    if (typeof body.system_prompt !== 'string') return 'system_prompt must be a string';
    if ((body.system_prompt as string).length > MAX_SYSTEM_PROMPT_LENGTH) {
      return `system_prompt exceeds maximum length of ${MAX_SYSTEM_PROMPT_LENGTH} characters`;
    }
  }

  if (body.tools !== undefined) {
    const err = validateToolsShape(body.tools);
    if (err) return err;
  }

  return null;
}

router.get('/agents', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, tenant_id, name, type, status, voice, model, temperature,
              system_prompt, welcome_greeting, escalation_config, metadata, created_at, updated_at
       FROM agents WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');

    return res.json({ agents: rows, total: parseInt(countRows[0].total as string), limit, offset });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list agents', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list agents' });
  } finally {
    client.release();
  }
});

router.post('/agents', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;
  const { name, type = 'general', system_prompt, welcome_greeting, voice = 'alloy', model = 'gpt-4o-realtime-preview',
          temperature = 0.8, tools = [], escalation_config = {}, metadata = {} } = body;

  const validationError = validateAgentInput(body, true);
  if (validationError) return res.status(400).json({ error: validationError });

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `INSERT INTO agents (tenant_id, name, type, system_prompt, welcome_greeting, voice, model, temperature, tools, escalation_config, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [tenantId, name, type, system_prompt ?? null, welcome_greeting ?? null, voice, model, temperature,
       JSON.stringify(tools), JSON.stringify(escalation_config), JSON.stringify(metadata)],
    );
    await client.query('COMMIT');

    logger.info('Agent created', { tenantId, agentId: rows[0].id });
    return res.status(201).json({ agent: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to create agent', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create agent' });
  } finally {
    client.release();
  }
});

router.get('/agents/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Agent not found' });
    return res.json({ agent: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to retrieve agent' });
  } finally {
    client.release();
  }
});

router.patch('/agents/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const validationError = validateAgentInput(body, false);
  if (validationError) return res.status(400).json({ error: validationError });

  const allowed = ['name', 'type', 'status', 'system_prompt', 'welcome_greeting', 'voice', 'model', 'temperature', 'tools', 'escalation_config', 'metadata'];
  const updates: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [id, tenantId];

  for (const key of allowed) {
    if (key in body) {
      const val = ['tools', 'escalation_config', 'metadata'].includes(key)
        ? JSON.stringify(body[key])
        : body[key];
      values.push(val);
      updates.push(`${key} = $${values.length}`);
    }
  }

  if (updates.length === 1) return res.status(400).json({ error: 'No valid fields to update' });

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    if ('system_prompt' in body) {
      const { rows: currentRows } = await client.query(
        `SELECT system_prompt FROM agents WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      if (currentRows.length > 0 && currentRows[0].system_prompt) {
        const { rows: versionRows } = await client.query(
          `SELECT COALESCE(MAX(version), 0) AS max_version FROM agent_prompt_versions WHERE agent_id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
        const nextVersion = (versionRows[0].max_version as number) + 1;
        await client.query(
          `INSERT INTO agent_prompt_versions (tenant_id, agent_id, version, system_prompt, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, id, nextVersion, currentRows[0].system_prompt, req.user!.userId],
        );
        logger.info('Archived agent prompt version', { tenantId, agentId: id, version: nextVersion });
      }
    }

    const { rows } = await client.query(
      `UPDATE agents SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Agent not found' });

    const changedFields = Object.keys(body).filter((k) => allowed.includes(k));
    writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'agent.updated',
      resourceType: 'agent',
      resourceId: id,
      changes: { fields: changedFields },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ agent: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update agent', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update agent' });
  } finally {
    client.release();
  }
});

router.delete('/agents/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rowCount } = await client.query(
      `DELETE FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (!rowCount) return res.status(404).json({ error: 'Agent not found' });
    logger.info('Agent deleted', { tenantId, agentId: id });
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to delete agent' });
  } finally {
    client.release();
  }
});

router.get('/agents/:id/prompt-versions', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: agentRows } = await client.query(
      `SELECT id FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (agentRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { rows } = await client.query(
      `SELECT id, version, system_prompt, notes, created_by, created_at
       FROM agent_prompt_versions
       WHERE agent_id = $1 AND tenant_id = $2
       ORDER BY version DESC`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    return res.json({ versions: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list prompt versions', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to list prompt versions' });
  } finally {
    client.release();
  }
});

router.post('/agents/:id/prompt-versions/:version/restore', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id, version } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: versionRows } = await client.query(
      `SELECT system_prompt FROM agent_prompt_versions
       WHERE agent_id = $1 AND tenant_id = $2 AND version = $3`,
      [id, tenantId, parseInt(version, 10)],
    );

    if (versionRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Prompt version not found' });
    }

    const { rows: currentRows } = await client.query(
      `SELECT system_prompt FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (currentRows.length > 0 && currentRows[0].system_prompt) {
      const { rows: maxRows } = await client.query(
        `SELECT COALESCE(MAX(version), 0) AS max_version FROM agent_prompt_versions WHERE agent_id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      const nextVersion = (maxRows[0].max_version as number) + 1;
      await client.query(
        `INSERT INTO agent_prompt_versions (tenant_id, agent_id, version, system_prompt, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, id, nextVersion, currentRows[0].system_prompt, `Archived before restoring v${version}`, req.user!.userId],
      );
    }

    const { rows } = await client.query(
      `UPDATE agents SET system_prompt = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [versionRows[0].system_prompt, id, tenantId],
    );
    await client.query('COMMIT');

    logger.info('Agent prompt restored', { tenantId, agentId: id, restoredVersion: version });
    return res.json({ agent: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to restore prompt version', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to restore prompt version' });
  } finally {
    client.release();
  }
});

router.get('/agents/:id/tools', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: agentRows } = await client.query(
      `SELECT id, type FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (agentRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agentType = agentRows[0].type as string;
    const permissions = getTemplatePermissions(agentType);
    const allTools = getAllKnownTools();

    const { rows: overrideRows } = await client.query(
      `SELECT tool_name, is_enabled FROM agent_tools WHERE agent_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    const overrideMap = new Map<string, boolean>();
    for (const row of overrideRows) {
      overrideMap.set(row.tool_name as string, row.is_enabled as boolean);
    }

    const tools = allTools.map((toolName) => {
      const override = overrideMap.get(toolName);
      const isAllowedByTemplate = permissions.allowedTools.includes(toolName);
      const isDeniedByTemplate = permissions.deniedTools.includes(toolName);

      let enabled: boolean;
      if (override !== undefined) {
        enabled = override;
      } else if (isAllowedByTemplate) {
        enabled = true;
      } else if (isDeniedByTemplate) {
        enabled = false;
      } else {
        enabled = permissions.allowedTools.length === 0;
      }

      return {
        name: toolName,
        enabled,
        allowedByTemplate: isAllowedByTemplate,
        deniedByTemplate: isDeniedByTemplate,
        hasOverride: override !== undefined,
      };
    });

    return res.json({ tools, agentType, templatePermissions: permissions });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get agent tools', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to get agent tools' });
  } finally {
    client.release();
  }
});

router.patch('/agents/:id/tools', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const overrides = body.overrides;
  if (!Array.isArray(overrides)) {
    return res.status(400).json({ error: 'overrides must be an array of { toolName: string, enabled: boolean }' });
  }

  const knownTools = new Set(getAllKnownTools());

  for (let i = 0; i < overrides.length; i++) {
    const o = overrides[i] as Record<string, unknown>;
    if (typeof o.toolName !== 'string' || typeof o.enabled !== 'boolean') {
      return res.status(400).json({ error: `overrides[${i}] must have toolName (string) and enabled (boolean)` });
    }
    if (!knownTools.has(o.toolName as string)) {
      return res.status(400).json({ error: `overrides[${i}].toolName "${o.toolName}" is not a recognized tool` });
    }
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: agentRows } = await client.query(
      `SELECT id FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (agentRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Agent not found' });
    }

    await client.query(
      `DELETE FROM agent_tools WHERE agent_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    for (const o of overrides as Array<{ toolName: string; enabled: boolean }>) {
      await client.query(
        `INSERT INTO agent_tools (tenant_id, agent_id, tool_name, is_enabled)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, id, o.toolName, o.enabled],
      );
    }

    await client.query('COMMIT');

    writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'agent.tools_updated',
      resourceType: 'agent',
      resourceId: id,
      changes: { overrides },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    logger.info('Agent tool overrides updated', { tenantId, agentId: id, overrideCount: overrides.length });
    return res.json({ success: true, overrides });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update agent tools', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update agent tools' });
  } finally {
    client.release();
  }
});

export default router;
