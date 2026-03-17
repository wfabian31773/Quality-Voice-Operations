import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  runAutopilotScan,
  getAutopilotInsights,
  getAutopilotRecommendations,
  getAutopilotRuns,
  getAutopilotDashboardSummary,
  approveRecommendation,
  rejectRecommendation,
  dismissRecommendation,
  executeAction,
  rollbackAction,
  getActionHistory,
  getPolicies,
  upsertPolicy,
  getImpactReports,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getAvailableIndustryPacks,
} from '../../../platform/autopilot';

const logger = createLogger('AUTOPILOT_API');
const router = Router();

router.get('/autopilot/summary', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const summary = await getAutopilotDashboardSummary(tenantId);
    return res.json(summary);
  } catch (err) {
    logger.error('Failed to fetch autopilot summary', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch autopilot summary' });
  }
});

router.get('/autopilot/insights', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const status = req.query.status ? String(req.query.status) : undefined;
  const severity = req.query.severity ? String(req.query.severity) : undefined;
  const category = req.query.category ? String(req.query.category) : undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const result = await getAutopilotInsights(tenantId, { status, severity, category, limit, offset });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch autopilot insights', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch autopilot insights' });
  }
});

router.get('/autopilot/recommendations', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const status = req.query.status ? String(req.query.status) : undefined;
  const riskTier = req.query.riskTier ? String(req.query.riskTier) : undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const result = await getAutopilotRecommendations(tenantId, { status, riskTier, limit, offset });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch autopilot recommendations', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch autopilot recommendations' });
  }
});

router.post('/autopilot/recommendations/:id/approve', requireAuth, requireRole('viewer'), async (req, res) => {
  const { tenantId, userId, role } = req.user!;
  const { id } = req.params;

  try {
    const rec = await approveRecommendation(tenantId, id, userId, role);
    if (!rec) return res.status(404).json({ error: 'Recommendation not found or not pending' });
    return res.json({ recommendation: rec });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Insufficient role')) {
      return res.status(403).json({ error: message });
    }
    logger.error('Failed to approve recommendation', { tenantId, id, error: message });
    return res.status(500).json({ error: 'Failed to approve recommendation' });
  }
});

router.post('/autopilot/recommendations/:id/reject', requireAuth, requireRole('viewer'), async (req, res) => {
  const { tenantId, userId, role } = req.user!;
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const rec = await rejectRecommendation(tenantId, id, userId, role, reason);
    if (!rec) return res.status(404).json({ error: 'Recommendation not found or not pending' });
    return res.json({ recommendation: rec });
  } catch (err) {
    logger.error('Failed to reject recommendation', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to reject recommendation' });
  }
});

router.post('/autopilot/recommendations/:id/dismiss', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;

  try {
    const rec = await dismissRecommendation(tenantId, id, userId);
    if (!rec) return res.status(404).json({ error: 'Recommendation not found or not pending' });
    return res.json({ recommendation: rec });
  } catch (err) {
    logger.error('Failed to dismiss recommendation', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to dismiss recommendation' });
  }
});

router.post('/autopilot/recommendations/:id/execute', requireAuth, requireRole('viewer'), async (req, res) => {
  const { tenantId, userId, role } = req.user!;
  const { id } = req.params;

  try {
    const action = await executeAction(tenantId, id, userId, false, role);
    if (!action) return res.status(404).json({ error: 'Recommendation not found' });
    return res.json({ action });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('must be approved')) {
      return res.status(400).json({ error: message });
    }
    if (message.includes('Insufficient role')) {
      return res.status(403).json({ error: message });
    }
    logger.error('Failed to execute action', { tenantId, id, error: message });
    return res.status(500).json({ error: 'Failed to execute action' });
  }
});

router.get('/autopilot/actions', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const status = req.query.status ? String(req.query.status) : undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const result = await getActionHistory(tenantId, { status, limit, offset });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch action history', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch action history' });
  }
});

router.post('/autopilot/actions/:id/rollback', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;

  try {
    const action = await rollbackAction(tenantId, id, userId);
    if (!action) return res.status(404).json({ error: 'Action not found or already rolled back' });
    return res.json({ action });
  } catch (err) {
    logger.error('Failed to rollback action', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to rollback action' });
  }
});

router.get('/autopilot/policies', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const policies = await getPolicies(tenantId);
    return res.json({ policies });
  } catch (err) {
    logger.error('Failed to fetch policies', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch policies' });
  }
});

router.post('/autopilot/policies', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { name, riskTier, actionType, requiresApproval, approvalRole, autoExecute, description } = req.body;

  const validRiskTiers = ['low', 'medium', 'high', 'critical'];
  const validApprovalRoles = ['member', 'manager', 'admin', 'owner'];

  if (!name || !riskTier || !actionType) {
    return res.status(400).json({ error: 'name, riskTier, and actionType are required' });
  }
  if (!validRiskTiers.includes(riskTier)) {
    return res.status(400).json({ error: `riskTier must be one of: ${validRiskTiers.join(', ')}` });
  }
  if (approvalRole && !validApprovalRoles.includes(approvalRole)) {
    return res.status(400).json({ error: `approvalRole must be one of: ${validApprovalRoles.join(', ')}` });
  }

  try {
    const policy = await upsertPolicy(tenantId, {
      name, riskTier, actionType,
      requiresApproval: requiresApproval ?? true,
      approvalRole: approvalRole ?? 'admin',
      autoExecute: autoExecute ?? false,
      description,
    });
    return res.json({ policy });
  } catch (err) {
    logger.error('Failed to upsert policy', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to save policy' });
  }
});

router.get('/autopilot/impact-reports', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const result = await getImpactReports(tenantId, { limit, offset });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch impact reports', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch impact reports' });
  }
});

router.get('/autopilot/runs', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);

  try {
    const runs = await getAutopilotRuns(tenantId, limit);
    return res.json({ runs });
  } catch (err) {
    logger.error('Failed to fetch autopilot runs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch autopilot runs' });
  }
});

router.post('/autopilot/scan', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const result = await runAutopilotScan(tenantId, 'manual');
    return res.json(result);
  } catch (err) {
    logger.error('Failed to run autopilot scan', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to run autopilot scan' });
  }
});

router.get('/autopilot/notifications', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const unreadOnly = req.query.unreadOnly === 'true';
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const result = await getNotifications(tenantId, { unreadOnly, limit, offset });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch notifications', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.post('/autopilot/notifications/:id/read', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const success = await markNotificationRead(tenantId, id);
    return res.json({ success });
  } catch (err) {
    logger.error('Failed to mark notification read', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

router.post('/autopilot/notifications/read-all', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const count = await markAllNotificationsRead(tenantId);
    return res.json({ count });
  } catch (err) {
    logger.error('Failed to mark all notifications read', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to mark all notifications read' });
  }
});

router.get('/autopilot/industry-packs', requireAuth, async (_req, res) => {
  try {
    const packs = getAvailableIndustryPacks();
    return res.json({ packs });
  } catch (err) {
    logger.error('Failed to fetch industry packs', { error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch industry packs' });
  }
});

export default router;
