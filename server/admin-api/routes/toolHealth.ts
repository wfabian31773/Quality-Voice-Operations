import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import { getToolHealthMetrics } from '../../../platform/tools/ToolHealthService';
import {
  listEscalationTasks,
  updateEscalationTask,
  getEscalationTaskStats,
} from '../../../platform/tools/HumanEscalationService';

const logger = createLogger('TOOL_HEALTH_API');
const router = Router();

router.get('/tool-health/metrics', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const windowParam = String(req.query.window ?? '7d');
  let windowDays = 7;
  if (windowParam === '24h' || windowParam === '1d') windowDays = 1;
  else if (windowParam === '7d') windowDays = 7;
  else if (windowParam === '30d') windowDays = 30;
  else if (windowParam === '90d') windowDays = 90;

  try {
    const [metrics, escalationStats] = await Promise.all([
      getToolHealthMetrics(tenantId, windowDays),
      getEscalationTaskStats(tenantId),
    ]);
    return res.json({ window: windowParam, ...metrics, escalationStats });
  } catch (err) {
    logger.error('Failed to fetch tool health metrics', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch tool health metrics' });
  }
});

router.get('/escalation-tasks', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { status, priority, limit, page } = req.query as Record<string, string | undefined>;

  const rawLimit = parseInt(limit ?? '50', 10);
  const parsedLimit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 200);
  const rawPage = parseInt(page ?? '1', 10);
  const parsedPage = Math.max(Number.isFinite(rawPage) ? rawPage : 1, 1);
  const offset = (parsedPage - 1) * parsedLimit;

  try {
    const result = await listEscalationTasks(tenantId, {
      status: status || undefined,
      priority: priority || undefined,
      limit: parsedLimit,
      offset,
    });

    return res.json({
      tasks: result.tasks,
      total: result.total,
      limit: parsedLimit,
      page: parsedPage,
      totalPages: Math.ceil(result.total / parsedLimit),
    });
  } catch (err) {
    logger.error('Failed to list escalation tasks', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list escalation tasks' });
  }
});

router.get('/escalation-tasks/stats', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const stats = await getEscalationTaskStats(tenantId);
    return res.json(stats);
  } catch (err) {
    logger.error('Failed to fetch escalation task stats', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch escalation task stats' });
  }
});

router.patch('/escalation-tasks/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { status, assignedTo, notes } = req.body;

  try {
    const updated = await updateEscalationTask(tenantId, id, {
      status: status || undefined,
      assignedTo,
      notes,
    });

    if (!updated) {
      return res.status(404).json({ error: 'Escalation task not found' });
    }

    return res.json({ task: updated });
  } catch (err) {
    logger.error('Failed to update escalation task', { tenantId, taskId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update escalation task' });
  }
});

export default router;
