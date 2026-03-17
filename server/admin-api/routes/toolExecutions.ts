import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  listToolExecutions,
  getToolExecution,
  getToolExecutionStats,
} from '../../../platform/tools/ToolExecutionService';
import { unifiedToolRegistry } from '../../../platform/tools/ToolRegistry';

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

router.get('/tools/registry', requireAuth, async (_req, res) => {
  try {
    const snapshot = unifiedToolRegistry.getRegistrySnapshot();
    return res.json({ tools: snapshot });
  } catch (err) {
    logger.error('Failed to get tool registry', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get tool registry' });
  }
});

export default router;
