import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import { getTemplatePermissions, getAllKnownTools } from '../../../platform/agent-templates/toolPermissions';
import { recordActivationEvent } from '../../../platform/activation/ActivationService';

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
              system_prompt, welcome_greeting, escalation_config, metadata,
              execution_mode, remote_system, remote_agent_id, last_sync_at,
              created_at, updated_at
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

router.post('/agents', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;
  const { name, type = 'general', system_prompt, welcome_greeting, voice = 'alloy', model = 'gpt-4o-realtime-preview',
          temperature = 0.8, tools = [], escalation_config = {}, metadata = {} } = body;

  const validationError = validateAgentInput(body, true);
  if (validationError) return res.status(400).json({ error: validationError });

  const { checkTrialAgentLimit } = await import('../../../platform/billing/guardrails/TrialGuard');
  const agentLimitCheck = await checkTrialAgentLimit(tenantId);
  if (!agentLimitCheck.allowed) {
    return res.status(403).json({ error: agentLimitCheck.reason });
  }

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
    recordActivationEvent(tenantId, 'tenant_agent_created', { agentId: rows[0].id }).catch(() => {});
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

router.patch('/agents/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const validationError = validateAgentInput(body, false);
  if (validationError) return res.status(400).json({ error: validationError });

  const allowed = ['name', 'type', 'status', 'system_prompt', 'welcome_greeting', 'voice', 'model', 'temperature', 'tools', 'escalation_config', 'metadata', 'workflow_definition', 'workflow_id'];
  const updates: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [id, tenantId];

  for (const key of allowed) {
    if (key in body) {
      const val = ['tools', 'escalation_config', 'metadata', 'workflow_definition'].includes(key)
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

    const { rows: modeCheck } = await client.query(
      `SELECT execution_mode FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (modeCheck.length > 0 && modeCheck[0].execution_mode === 'federated') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Federated agents cannot be modified directly. They are managed by an external system.' });
    }

    if ('workflow_id' in body && body.workflow_id !== null && body.workflow_id !== undefined) {
      const { rows: wfRows } = await client.query(
        `SELECT id FROM workflows WHERE id = $1 AND tenant_id = $2`,
        [body.workflow_id, tenantId],
      );
      if (wfRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Referenced workflow not found in this tenant' });
      }
    }

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

router.delete('/agents/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: modeCheck } = await client.query(
      `SELECT execution_mode FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (modeCheck.length > 0 && modeCheck[0].execution_mode === 'federated') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Federated agents cannot be deleted. They are managed by an external system.' });
    }

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

router.post('/agents/:id/prompt-versions/:version/restore', requireAuth, requireRole('manager'), async (req, res) => {
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

router.patch('/agents/:id/tools', requireAuth, requireRole('manager'), async (req, res) => {
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

const MAX_WORKFLOW_NODES = 100;
const MAX_WORKFLOW_EDGES = 200;
const MAX_WORKFLOW_JSON_SIZE = 512_000;
const VALID_NODE_TYPES = new Set(['conversation', 'logic', 'action']);

function validateWorkflowDefinition(def: unknown): string | null {
  if (!def || typeof def !== 'object') return 'workflow_definition must be a JSON object';
  const wd = def as Record<string, unknown>;

  const jsonStr = JSON.stringify(wd);
  if (jsonStr.length > MAX_WORKFLOW_JSON_SIZE) {
    return `workflow_definition exceeds maximum size of ${MAX_WORKFLOW_JSON_SIZE} bytes`;
  }

  if (!Array.isArray(wd.nodes)) return 'workflow_definition.nodes must be an array';
  if (!Array.isArray(wd.edges)) return 'workflow_definition.edges must be an array';

  if (wd.nodes.length > MAX_WORKFLOW_NODES) {
    return `workflow_definition.nodes exceeds maximum of ${MAX_WORKFLOW_NODES} nodes`;
  }
  if (wd.edges.length > MAX_WORKFLOW_EDGES) {
    return `workflow_definition.edges exceeds maximum of ${MAX_WORKFLOW_EDGES} edges`;
  }

  for (let i = 0; i < wd.nodes.length; i++) {
    const node = wd.nodes[i] as Record<string, unknown>;
    if (!node || typeof node !== 'object') return `nodes[${i}] must be an object`;
    if (typeof node.id !== 'string') return `nodes[${i}].id must be a string`;
    if (typeof node.type !== 'string' || !VALID_NODE_TYPES.has(node.type)) {
      return `nodes[${i}].type must be one of: ${[...VALID_NODE_TYPES].join(', ')}`;
    }
    if (!node.position || typeof node.position !== 'object') return `nodes[${i}].position must be an object`;
  }

  const nodeMap = new Map<string, string>();
  for (const n of wd.nodes) {
    const nd = (n as Record<string, unknown>).data as Record<string, unknown> | undefined;
    if (nd && typeof nd.nodeType === 'string') {
      nodeMap.set((n as Record<string, unknown>).id as string, nd.nodeType);
    }
  }

  const EDGE_RULES: Record<string, string[]> = {
    greeting: ['askQuestion', 'confirmInfo', 'condition', 'routeDecision', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob'],
    askQuestion: ['askQuestion', 'confirmInfo', 'condition', 'routeDecision', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob'],
    confirmInfo: ['condition', 'routeDecision', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob', 'askQuestion'],
    condition: ['askQuestion', 'confirmInfo', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob', 'condition', 'routeDecision'],
    routeDecision: ['askQuestion', 'confirmInfo', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob', 'condition'],
    createTicket: ['sendSms', 'scheduleAppt', 'confirmInfo', 'askQuestion'],
    createContact: ['sendSms', 'scheduleAppt', 'confirmInfo', 'createTicket', 'askQuestion'],
    scheduleAppt: ['sendSms', 'confirmInfo', 'createTicket', 'askQuestion'],
    sendSms: ['confirmInfo', 'askQuestion'],
    dispatchJob: ['sendSms', 'confirmInfo', 'askQuestion'],
  };

  for (let i = 0; i < wd.edges.length; i++) {
    const edge = wd.edges[i] as Record<string, unknown>;
    if (!edge || typeof edge !== 'object') return `edges[${i}] must be an object`;
    if (typeof edge.source !== 'string') return `edges[${i}].source must be a string`;
    if (typeof edge.target !== 'string') return `edges[${i}].target must be a string`;
    if (edge.source === edge.target) return `edges[${i}] cannot connect a node to itself`;

    const srcType = nodeMap.get(edge.source as string);
    const tgtType = nodeMap.get(edge.target as string);
    if (srcType && tgtType && EDGE_RULES[srcType]) {
      if (!EDGE_RULES[srcType].includes(tgtType)) {
        return `edges[${i}]: invalid connection from ${srcType} to ${tgtType}`;
      }
    }
  }

  return null;
}

router.patch('/agents/:id/workflow', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;
  const { workflow_definition, workflow_id } = body;

  const validationError = validateWorkflowDefinition(workflow_definition);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    if (workflow_id !== undefined && workflow_id !== null) {
      const { rows: wfRows } = await client.query(
        `SELECT id FROM workflows WHERE id = $1 AND tenant_id = $2`,
        [workflow_id, tenantId],
      );
      if (wfRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Referenced workflow not found' });
      }
    }

    const { rows } = await client.query(
      `UPDATE agents SET workflow_definition = $1, workflow_id = $2, updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4 RETURNING *`,
      [JSON.stringify(workflow_definition), workflow_id ?? null, id, tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Agent not found' });

    writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'agent.workflow_updated',
      resourceType: 'agent',
      resourceId: id,
      changes: { workflow_definition: 'updated' },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ agent: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update workflow', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update workflow' });
  } finally {
    client.release();
  }
});

const WORKFLOW_NODE_TO_TOOL: Record<string, string> = {
  createTicket: 'createServiceTicket',
  createContact: 'createContact',
  scheduleAppt: 'bookServiceAppointment',
  sendSms: 'sendSms',
  dispatchJob: 'dispatchTechnician',
};

function compileWorkflowToPrompt(wd: Record<string, unknown>): { systemPromptSection: string; workflowTools: Record<string, unknown>[] } {
  const nodes = (wd.nodes || []) as Record<string, unknown>[];
  const edges = (wd.edges || []) as Record<string, unknown>[];

  if (nodes.length === 0) {
    return { systemPromptSection: '', workflowTools: [] };
  }

  const nodeMap = new Map<string, Record<string, unknown>>();
  for (const n of nodes) {
    nodeMap.set(n.id as string, n);
  }

  const targetIds = new Set(edges.map((e) => e.target as string));
  const startNodeIds = nodes.filter((n) => !targetIds.has(n.id as string)).map((n) => n.id as string);

  const getOutgoingEdges = (nodeId: string) =>
    edges.filter((e) => e.source === nodeId);

  const lines: string[] = ['\n## Conversation Workflow\nFollow these steps in order during the call:\n'];
  const workflowTools: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let stepNum = 1;

  function walkNode(nodeId: string, indent: string = '') {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const data = (node.data || {}) as Record<string, unknown>;
    const nodeType = (data.nodeType as string) || '';
    const label = (data.label as string) || nodeType;

    const conversationTypes = ['greeting', 'askQuestion', 'confirmInfo'];
    const logicTypes = ['condition', 'routeDecision'];
    const actionTypes = ['createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob'];

    if (conversationTypes.includes(nodeType)) {
      const prompt = (data.prompt as string) || '';
      lines.push(`${indent}**Step ${stepNum}: ${label}**`);
      if (prompt) lines.push(`${indent}  ${prompt}`);
      stepNum++;
    } else if (logicTypes.includes(nodeType)) {
      const cond = (data.conditionField as string) || '';
      lines.push(`${indent}**Step ${stepNum}: ${label}** — Evaluate: ${cond}`);
      stepNum++;

      const outEdges = getOutgoingEdges(nodeId);
      for (const edge of outEdges) {
        const edgeLabel = (edge.label as string) || edge.sourceHandle || 'then';
        lines.push(`${indent}  - If ${edgeLabel}:`);
        walkNode(edge.target as string, indent + '    ');
      }
      return;
    } else if (actionTypes.includes(nodeType)) {
      const config = (data.toolConfig as string) || '';
      lines.push(`${indent}**Step ${stepNum}: ${label}** — Execute action`);
      if (config) lines.push(`${indent}  Configuration: ${config}`);
      stepNum++;

      const toolName = WORKFLOW_NODE_TO_TOOL[nodeType] || nodeType;
      if (!workflowTools.find((t) => (t as Record<string, unknown>).name === toolName)) {
        workflowTools.push({
          name: toolName,
          description: `${label}. ${config}`.trim(),
          parameters: { type: 'object', properties: {} },
        });
      }
    }

    const outEdges = getOutgoingEdges(nodeId);
    for (const edge of outEdges) {
      walkNode(edge.target as string, indent);
    }
  }

  for (const startId of startNodeIds) {
    walkNode(startId);
  }
  for (const n of nodes) {
    if (!visited.has(n.id as string)) {
      walkNode(n.id as string);
    }
  }

  return { systemPromptSection: lines.join('\n'), workflowTools };
}

router.post('/agents/:id/publish', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: agentRows } = await client.query(
      `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (agentRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = agentRows[0];

    const wd = agent.workflow_definition
      ? (typeof agent.workflow_definition === 'string' ? JSON.parse(agent.workflow_definition) : agent.workflow_definition)
      : { nodes: [], edges: [], settings: {} };

    const draftSettings = (wd.settings || {}) as Record<string, unknown>;

    const publishVoice = (draftSettings.voice as string) || agent.voice || 'alloy';
    const publishModel = (draftSettings.model as string) || agent.model || 'gpt-4o-realtime-preview';
    const publishTemp = (draftSettings.temperature as number) ?? agent.temperature ?? 0.8;
    const publishGreeting = (draftSettings.welcome_greeting as string) ?? agent.welcome_greeting ?? '';
    const publishName = (draftSettings.name as string) || agent.name;
    const basePrompt = (draftSettings.system_prompt as string) ?? agent.system_prompt ?? '';
    const language = (draftSettings.language as string) || '';
    const tone = (draftSettings.tone as string) || '';

    let compiledPrompt = basePrompt;
    if (language && language !== 'English') {
      compiledPrompt += `\n\nSpeak in ${language}.`;
    }
    if (tone) {
      compiledPrompt += `\nMaintain a ${tone.toLowerCase()} tone throughout the conversation.`;
    }

    let compiledTools = agent.tools ? (Array.isArray(agent.tools) ? [...agent.tools] : JSON.parse(agent.tools)) : [];

    const { systemPromptSection, workflowTools } = compileWorkflowToPrompt(wd);
    if (systemPromptSection) {
      compiledPrompt = compiledPrompt.trimEnd() + '\n' + systemPromptSection;
    }
    if (workflowTools.length > 0) {
      const templatePerms = getTemplatePermissions(agent.type || 'general');
      const deniedSet = new Set(templatePerms.deniedTools);
      const existingToolNames = new Set(compiledTools.map((t: Record<string, unknown>) => t.name));
      for (const wt of workflowTools) {
        if (!existingToolNames.has(wt.name as string) && !deniedSet.has(wt.name as string)) {
          compiledTools.push(wt);
        }
      }
    }

    const { rows: maxRows } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS max_version FROM agent_versions WHERE agent_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const nextVersion = (maxRows[0].max_version as number) + 1;

    await client.query(
      `INSERT INTO agent_versions (tenant_id, agent_id, version, status, workflow_definition, system_prompt, voice, model, temperature, welcome_greeting, tools, published_at, published_by)
       VALUES ($1, $2, $3, 'published', $4, $5, $6, $7, $8, $9, $10, NOW(), $11)`,
      [tenantId, id, nextVersion, JSON.stringify(wd), compiledPrompt, publishVoice, publishModel, publishTemp, publishGreeting, JSON.stringify(compiledTools), req.user!.userId],
    );

    const existingMeta = agent.metadata
      ? (typeof agent.metadata === 'string' ? JSON.parse(agent.metadata) : agent.metadata)
      : {};
    const mergedMeta = { ...existingMeta, language, tone, speakingRate: draftSettings.speakingRate || 1.0 };

    await client.query(
      `UPDATE agents SET name = $1, system_prompt = $2, voice = $3, model = $4, temperature = $5, welcome_greeting = $6, tools = $7,
       published_workflow_definition = workflow_definition, published_version = $8, metadata = $9, updated_at = NOW()
       WHERE id = $10 AND tenant_id = $11`,
      [publishName, compiledPrompt, publishVoice, publishModel, publishTemp, publishGreeting, JSON.stringify(compiledTools),
       nextVersion, JSON.stringify(mergedMeta), id, tenantId],
    );

    await client.query('COMMIT');

    writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'agent.published',
      resourceType: 'agent',
      resourceId: id,
      changes: { version: nextVersion },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    logger.info('Agent published', { tenantId, agentId: id, version: nextVersion });
    import('../../../platform/activation/ActivationService')
      .then(({ recordActivationEvent }) => recordActivationEvent(tenantId, 'tenant_agent_deployed', { agentId: id, version: nextVersion }))
      .catch(() => {});
    return res.json({ version: nextVersion, status: 'published' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to publish agent', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to publish agent' });
  } finally {
    client.release();
  }
});

router.get('/agents/:id/versions', requireAuth, requireRole('manager'), async (req, res) => {
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
      `SELECT id, version, status, published_at, published_by, created_at
       FROM agent_versions
       WHERE agent_id = $1 AND tenant_id = $2
       ORDER BY version DESC`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    return res.json({ versions: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list versions', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to list versions' });
  } finally {
    client.release();
  }
});

router.post('/agents/:id/rollback', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;
  const targetVersion = parseInt(String(body.version), 10);

  if (!targetVersion || isNaN(targetVersion)) {
    return res.status(400).json({ error: 'version is required (integer)' });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: versionRows } = await client.query(
      `SELECT * FROM agent_versions
       WHERE agent_id = $1 AND tenant_id = $2 AND version = $3`,
      [id, tenantId, targetVersion],
    );

    if (versionRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Version not found' });
    }

    const v = versionRows[0];

    const vWd = v.workflow_definition
      ? (typeof v.workflow_definition === 'string' ? JSON.parse(v.workflow_definition) : v.workflow_definition)
      : {};
    const vSettings = (vWd.settings || {}) as Record<string, unknown>;
    const rollbackName = (vSettings.name as string) || null;
    const rollbackMeta = vSettings.language || vSettings.tone
      ? JSON.stringify({ language: vSettings.language, tone: vSettings.tone, speakingRate: vSettings.speakingRate })
      : null;

    const updateFields = [
      'workflow_definition = $3',
      'published_workflow_definition = $3',
      'system_prompt = $4',
      'voice = $5',
      'model = $6',
      'temperature = $7',
      'welcome_greeting = $8',
      'tools = $9',
      'published_version = $10',
      'updated_at = NOW()',
    ];
    const updateValues: unknown[] = [
      id,
      tenantId,
      v.workflow_definition ? JSON.stringify(v.workflow_definition) : null,
      v.system_prompt ?? null,
      v.voice ?? null,
      v.model ?? null,
      v.temperature ?? null,
      v.welcome_greeting ?? null,
      v.tools ? JSON.stringify(v.tools) : null,
      targetVersion,
    ];

    if (rollbackName) {
      updateValues.push(rollbackName);
      updateFields.push(`name = $${updateValues.length}`);
    }
    if (rollbackMeta) {
      updateValues.push(rollbackMeta);
      updateFields.push(`metadata = $${updateValues.length}`);
    }

    const { rows } = await client.query(
      `UPDATE agents SET ${updateFields.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      updateValues,
    );
    await client.query('COMMIT');

    writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'agent.rollback',
      resourceType: 'agent',
      resourceId: id,
      changes: { rolledBackToVersion: targetVersion },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    logger.info('Agent rolled back', { tenantId, agentId: id, toVersion: targetVersion });
    return res.json({ agent: rows[0], restoredVersion: targetVersion });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to rollback agent', { tenantId, agentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to rollback agent' });
  } finally {
    client.release();
  }
});

export default router;
