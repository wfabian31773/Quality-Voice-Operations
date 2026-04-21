import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole, requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  listToolExecutions,
  getToolExecution,
  getToolExecutionStats,
} from '../../../platform/tools/ToolExecutionService';
import { unifiedToolRegistry } from '../../../platform/tools/ToolRegistry';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { getTemplatePermissions, getAllKnownTools } from '../../../platform/agent-templates/toolPermissions';

const logger = createLogger('TOOL_EXECUTIONS_API');
const router = Router();

router.get('/tool-executions', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const {
    callSessionId,
    agentId,
    toolName,
    status,
    startDate,
    endDate,
    limit,
    page,
  } = req.query as Record<string, string | undefined>;

  const rawLimit = parseInt(limit ?? '50', 10);
  const parsedLimit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 200);
  const rawPage = parseInt(page ?? '1', 10);
  const parsedPage = Math.max(Number.isFinite(rawPage) ? rawPage : 1, 1);
  const offset = (parsedPage - 1) * parsedLimit;

  try {
    const result = await listToolExecutions({
      tenantId,
      callSessionId: callSessionId || undefined,
      agentId: agentId || undefined,
      toolName: toolName || undefined,
      status: status || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: parsedLimit,
      offset,
    });

    return res.json({
      executions: result.executions,
      total: result.total,
      limit: parsedLimit,
      page: parsedPage,
      totalPages: Math.ceil(result.total / parsedLimit),
    });
  } catch (err) {
    logger.error('Failed to list tool executions', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list tool executions' });
  }
});

router.get('/tool-executions/stats', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const windowParam = String(req.query.window ?? '7d');
  let windowDays = 7;
  if (windowParam === '24h' || windowParam === '1d') windowDays = 1;
  else if (windowParam === '7d') windowDays = 7;
  else if (windowParam === '30d') windowDays = 30;

  try {
    const stats = await getToolExecutionStats(tenantId, windowDays);
    return res.json({ window: windowParam, ...stats });
  } catch (err) {
    logger.error('Failed to fetch tool execution stats', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch tool execution stats' });
  }
});

router.get('/tool-executions/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const execution = await getToolExecution(tenantId, id);
    if (!execution) {
      return res.status(404).json({ error: 'Tool execution not found' });
    }
    return res.json({ execution });
  } catch (err) {
    logger.error('Failed to get tool execution', { tenantId, executionId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to get tool execution' });
  }
});

router.post('/tool-executions/:id/replay', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  try {
    const execution = await getToolExecution(tenantId, id);
    if (!execution) {
      return res.status(404).json({ error: 'Tool execution not found' });
    }

    return res.json({
      replay: {
        mode: 'dry-run',
        originalExecution: execution,
        wouldExecute: {
          toolName: execution.toolName,
          parametersRedacted: execution.parametersRedacted,
        },
        message: 'Replay is dry-run only. Original parameters are PHI-redacted and cannot be re-executed. Use the tool registry and a fresh call to re-test tool behavior.',
      },
    });
  } catch (err) {
    logger.error('Failed to replay tool execution', { tenantId, executionId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to replay tool execution' });
  }
});

router.get('/tools/registry', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: agents } = await client.query(
      `SELECT id, type FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    const { rows: overrideRows } = await client.query(
      `SELECT agent_id, tool_name, is_enabled FROM agent_tools WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');

    const overridesByAgent = new Map<string, Map<string, boolean>>();
    for (const row of overrideRows) {
      let m = overridesByAgent.get(row.agent_id as string);
      if (!m) {
        m = new Map();
        overridesByAgent.set(row.agent_id as string, m);
      }
      m.set(row.tool_name as string, row.is_enabled as boolean);
    }

    const enabled = new Set<string>();
    const knownTools = getAllKnownTools();
    for (const agent of agents) {
      const permissions = getTemplatePermissions(agent.type as string);
      const overrides = overridesByAgent.get(agent.id as string) ?? new Map<string, boolean>();
      for (const toolName of knownTools) {
        const override = overrides.get(toolName);
        let isEnabled: boolean;
        if (override !== undefined) {
          isEnabled = override;
        } else if (permissions.allowedTools.includes(toolName)) {
          isEnabled = true;
        } else if (permissions.deniedTools.includes(toolName)) {
          isEnabled = false;
        } else {
          isEnabled = permissions.allowedTools.length === 0;
        }
        if (isEnabled) enabled.add(toolName);
      }
    }

    const snapshot = unifiedToolRegistry
      .getRegistrySnapshot()
      .filter((t) => enabled.has(t.name));
    return res.json({ tools: snapshot });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to list tenant tool registry', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list tool registry' });
  } finally {
    client.release();
  }
});

router.get('/platform/tools/registry', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const snapshot = unifiedToolRegistry.getRegistrySnapshot();
    return res.json({ tools: snapshot });
  } catch (err) {
    logger.error('Failed to get platform tool registry', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get tool registry' });
  }
});

export default router;
