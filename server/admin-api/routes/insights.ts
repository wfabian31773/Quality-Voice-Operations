import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../../../platform/core/logger';
import {
  runInsightsAnalysis,
  getInsights,
  getInsightsSummary,
  updateInsightStatus,
  generateWeeklyReport,
  getWeeklyReports,
  detectAnomalies,
  getAlertHistory,
  acknowledgeAlert,
} from '../../../platform/analytics';

const logger = createLogger('INSIGHTS_API');
const router = Router();

router.get('/insights', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const status = req.query.status ? String(req.query.status) : undefined;
  const category = req.query.category ? String(req.query.category) : undefined;
  const parsedLimit = parseInt(String(req.query.limit ?? '50'), 10);
  const limit = Math.min(isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit, 100);
  const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
  const offset = isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;

  try {
    const result = await getInsights(tenantId, { status, category, limit, offset });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch insights', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch insights' });
  }
});

router.get('/insights/summary', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const summary = await getInsightsSummary(tenantId);
    return res.json(summary);
  } catch (err) {
    logger.error('Failed to fetch insights summary', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch insights summary' });
  }
});

router.post('/insights/analyze', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const insights = await runInsightsAnalysis(tenantId);
    return res.json({ insights, count: insights.length });
  } catch (err) {
    logger.error('Failed to run insights analysis', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to run insights analysis' });
  }
});

router.post('/insights/:id/status', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !['accepted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Status must be "accepted" or "dismissed"' });
  }

  try {
    const insight = await updateInsightStatus(tenantId, id, status, userId);
    if (!insight) {
      return res.status(404).json({ error: 'Insight not found' });
    }
    return res.json({ insight });
  } catch (err) {
    logger.error('Failed to update insight status', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update insight status' });
  }
});

router.get('/insights/weekly-reports', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const parsedReportLimit = parseInt(String(req.query.limit ?? '12'), 10);
  const limit = Math.min(isNaN(parsedReportLimit) || parsedReportLimit < 1 ? 12 : parsedReportLimit, 52);

  try {
    const reports = await getWeeklyReports(tenantId, limit);
    return res.json({ reports });
  } catch (err) {
    logger.error('Failed to fetch weekly reports', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch weekly reports' });
  }
});

router.post('/insights/weekly-report', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    const report = await generateWeeklyReport(tenantId);
    return res.json({ report });
  } catch (err) {
    logger.error('Failed to generate weekly report', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to generate weekly report' });
  }
});

router.post('/insights/detect-anomalies', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  try {
    await detectAnomalies(tenantId);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to detect anomalies', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to detect anomalies' });
  }
});

router.get('/insights/alerts', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const parsedLimit = parseInt(String(req.query.limit ?? '50'), 10);
  const limit = Math.min(isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit, 100);
  const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
  const offset = isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;
  const severity = req.query.severity ? String(req.query.severity) : undefined;

  try {
    const result = await getAlertHistory(tenantId, { limit, offset, severity });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to fetch alert history', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch alert history' });
  }
});

router.post('/insights/alerts/:id/acknowledge', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;

  try {
    const success = await acknowledgeAlert(tenantId, id);
    if (!success) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to acknowledge alert', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

export default router;
