import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { runSignalCollection, getSignals } from '../../../platform/evolution/SignalCollector';
import { runOpportunityDetection, getOpportunities, getOpportunityById } from '../../../platform/evolution/OpportunityDetectionEngine';
import { generateRoadmapRecommendations, getRecommendations, getRecommendationById, updateRecommendationStatus } from '../../../platform/evolution/RoadmapRecommendationEngine';
import { createExperiment, getExperiments, getExperimentById, updateExperimentState, updateExperiment } from '../../../platform/evolution/ExperimentManager';
import { startEvolutionScheduler, stopEvolutionScheduler, isSchedulerRunning, isPipelineRunning } from '../../../platform/evolution/EvolutionScheduler';
import { withPrivilegedClient } from '../../../platform/db';

const router = Router();
const logger = createLogger('EVOLUTION_API');

if (process.env.EVOLUTION_SCHEDULER_ENABLED === 'true') {
  const intervalHours = parseInt(process.env.EVOLUTION_SCHEDULER_INTERVAL_HOURS || '6', 10);
  startEvolutionScheduler(intervalHours * 60 * 60 * 1000);
  logger.info('Evolution scheduler auto-started', { intervalHours });
}

router.get('/evolution/signals', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { source, signal_type, limit, offset } = req.query;
    const result = await getSignals({
      source: source ? String(source) : undefined,
      signalType: signal_type ? String(signal_type) : undefined,
      limit: limit ? parseInt(String(limit), 10) : undefined,
      offset: offset ? parseInt(String(offset), 10) : undefined,
    });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to get evolution signals', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get signals' });
  }
});

router.post('/evolution/signals/collect', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const count = await runSignalCollection();
    return res.json({ success: true, signalsCollected: count });
  } catch (err) {
    logger.error('Signal collection failed', { error: String(err) });
    return res.status(500).json({ error: 'Signal collection failed' });
  }
});

router.get('/evolution/opportunities', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { type, status, min_score, limit, offset } = req.query;
    const result = await getOpportunities({
      type: type ? String(type) : undefined,
      status: status ? String(status) : undefined,
      minScore: min_score ? parseFloat(String(min_score)) : undefined,
      limit: limit ? parseInt(String(limit), 10) : undefined,
      offset: offset ? parseInt(String(offset), 10) : undefined,
    });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to get opportunities', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get opportunities' });
  }
});

router.get('/evolution/opportunities/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const opportunity = await getOpportunityById(req.params.id);
    if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });
    return res.json({ opportunity });
  } catch (err) {
    logger.error('Failed to get opportunity', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get opportunity' });
  }
});

router.post('/evolution/opportunities/detect', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const count = await runOpportunityDetection();
    return res.json({ success: true, opportunitiesDetected: count });
  } catch (err) {
    logger.error('Opportunity detection failed', { error: String(err) });
    return res.status(500).json({ error: 'Opportunity detection failed' });
  }
});

router.get('/evolution/recommendations', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { status, priority, limit, offset } = req.query;
    const result = await getRecommendations({
      status: status ? String(status) : undefined,
      priority: priority ? String(priority) : undefined,
      limit: limit ? parseInt(String(limit), 10) : undefined,
      offset: offset ? parseInt(String(offset), 10) : undefined,
    });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to get recommendations', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

router.get('/evolution/recommendations/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const recommendation = await getRecommendationById(req.params.id);
    if (!recommendation) return res.status(404).json({ error: 'Recommendation not found' });
    return res.json({ recommendation });
  } catch (err) {
    logger.error('Failed to get recommendation', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get recommendation' });
  }
});

router.post('/evolution/recommendations/generate', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const count = await generateRoadmapRecommendations();
    return res.json({ success: true, recommendationsGenerated: count });
  } catch (err) {
    logger.error('Recommendation generation failed', { error: String(err) });
    return res.status(500).json({ error: 'Recommendation generation failed' });
  }
});

router.patch('/evolution/recommendations/:id/status', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { status, reason } = req.body as { status?: string; reason?: string };
    if (!status) return res.status(400).json({ error: 'status is required' });

    const result = await updateRecommendationStatus(
      req.params.id,
      status,
      req.user!.userId,
      reason,
    );
    if (!result) return res.status(404).json({ error: 'Recommendation not found' });
    return res.json({ recommendation: result });
  } catch (err) {
    if (String(err).includes('Invalid status')) {
      return res.status(400).json({ error: String(err) });
    }
    logger.error('Failed to update recommendation status', { error: String(err) });
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

router.get('/evolution/experiments', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { state, type, limit, offset } = req.query;
    const result = await getExperiments({
      state: state ? String(state) : undefined,
      type: type ? String(type) : undefined,
      limit: limit ? parseInt(String(limit), 10) : undefined,
      offset: offset ? parseInt(String(offset), 10) : undefined,
    });
    return res.json(result);
  } catch (err) {
    logger.error('Failed to get experiments', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get experiments' });
  }
});

router.get('/evolution/experiments/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const experiment = await getExperimentById(req.params.id);
    if (!experiment) return res.status(404).json({ error: 'Experiment not found' });
    return res.json({ experiment });
  } catch (err) {
    logger.error('Failed to get experiment', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get experiment' });
  }
});

router.post('/evolution/experiments', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const body = req.body as {
      experimentName?: string;
      experimentType?: string;
      hypothesis?: string;
      description?: string;
      pilotTenantIds?: string[];
      config?: Record<string, unknown>;
      successCriteria?: Record<string, unknown>;
      opportunityId?: string;
    };

    if (!body.experimentName || !body.experimentType) {
      return res.status(400).json({ error: 'experimentName and experimentType are required' });
    }

    const experiment = await createExperiment({
      ...body,
      experimentName: body.experimentName,
      experimentType: body.experimentType,
      createdBy: req.user!.userId,
    });

    return res.status(201).json({ experiment });
  } catch (err) {
    logger.error('Failed to create experiment', { error: String(err) });
    return res.status(500).json({ error: 'Failed to create experiment' });
  }
});

router.patch('/evolution/experiments/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const result = await updateExperiment(req.params.id, req.body, req.user!.userId);
    if (!result) return res.status(404).json({ error: 'Experiment not found' });
    return res.json({ experiment: result });
  } catch (err) {
    logger.error('Failed to update experiment', { error: String(err) });
    return res.status(500).json({ error: 'Failed to update experiment' });
  }
});

router.patch('/evolution/experiments/:id/state', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { state, results } = req.body as { state?: string; results?: Record<string, unknown> };
    if (!state) return res.status(400).json({ error: 'state is required' });

    const experiment = await updateExperimentState(
      req.params.id,
      state,
      req.user!.userId,
      results,
    );
    if (!experiment) return res.status(404).json({ error: 'Experiment not found' });
    return res.json({ experiment });
  } catch (err) {
    if (String(err).includes('Invalid experiment state')) {
      return res.status(400).json({ error: String(err) });
    }
    logger.error('Failed to update experiment state', { error: String(err) });
    return res.status(500).json({ error: 'Failed to update state' });
  }
});

router.get('/evolution/dashboard', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const dashboard = await withPrivilegedClient(async (client) => {
      const { rows: [oppStats] } = await client.query(
        `SELECT
           COUNT(*)::int AS total_opportunities,
           COUNT(*) FILTER (WHERE composite_score >= 7)::int AS high_value,
           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_this_month
         FROM evolution_opportunities WHERE status = 'active'`,
      );

      const { rows: topOpportunities } = await client.query(
        `SELECT id, opportunity_type, title, composite_score, signal_count, affected_tenant_count, created_at
         FROM evolution_opportunities
         WHERE status = 'active'
         ORDER BY composite_score DESC
         LIMIT 5`,
      );

      const { rows: [recStats] } = await client.query(
        `SELECT
           COUNT(*)::int AS total_recommendations,
           COUNT(*) FILTER (WHERE status = 'proposed')::int AS pending,
           COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
           COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
           COALESCE(SUM(estimated_revenue_impact_cents) FILTER (WHERE status = 'approved'), 0)::bigint AS approved_revenue_cents
         FROM roadmap_recommendations`,
      );

      const { rows: topRecommendation } = await client.query(
        `SELECT id, title, recommended_priority, estimated_revenue_impact_cents, ai_explanation, created_at
         FROM roadmap_recommendations
         WHERE status = 'proposed'
         ORDER BY
           CASE recommended_priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           estimated_revenue_impact_cents DESC
         LIMIT 1`,
      );

      const { rows: verticalGrowth } = await client.query(
        `SELECT vertical_name, current_tenant_count, expansion_score, growth_rate
         FROM vertical_expansion_scores
         ORDER BY expansion_score DESC
         LIMIT 5`,
      );

      const { rows: topIntegrations } = await client.query(
        `SELECT integration_name, demand_score, request_count, unique_tenant_count
         FROM integration_demand_scores
         ORDER BY demand_score DESC
         LIMIT 5`,
      );

      const { rows: [expStats] } = await client.query(
        `SELECT
           COUNT(*)::int AS total_experiments,
           COUNT(*) FILTER (WHERE state = 'active')::int AS active,
           COUNT(*) FILTER (WHERE state = 'concluded')::int AS concluded
         FROM experiment_results`,
      );

      const { rows: [signalStats] } = await client.query(
        `SELECT
           COUNT(*)::int AS total_signals,
           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '7 days')::int AS signals_last_7d
         FROM evolution_signals`,
      );

      return {
        opportunities: {
          total: oppStats?.total_opportunities ?? 0,
          highValue: oppStats?.high_value ?? 0,
          newThisMonth: oppStats?.new_this_month ?? 0,
          top5: topOpportunities,
        },
        recommendations: {
          total: recStats?.total_recommendations ?? 0,
          pending: recStats?.pending ?? 0,
          approved: recStats?.approved ?? 0,
          rejected: recStats?.rejected ?? 0,
          approvedRevenueCents: parseInt(String(recStats?.approved_revenue_cents ?? 0), 10),
          topRecommendation: topRecommendation[0] ?? null,
        },
        verticalGrowth,
        topIntegrations,
        experiments: {
          total: expStats?.total_experiments ?? 0,
          active: expStats?.active ?? 0,
          concluded: expStats?.concluded ?? 0,
        },
        signals: {
          total: signalStats?.total_signals ?? 0,
          last7d: signalStats?.signals_last_7d ?? 0,
        },
      };
    });

    return res.json({ dashboard });
  } catch (err) {
    logger.error('Failed to get evolution dashboard', { error: String(err) });
    return res.status(500).json({ error: 'Failed to get dashboard' });
  }
});

router.post('/evolution/run-pipeline', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const signalsCollected = await runSignalCollection();
    const opportunitiesDetected = await runOpportunityDetection();
    const recommendationsGenerated = await generateRoadmapRecommendations();

    return res.json({
      success: true,
      signalsCollected,
      opportunitiesDetected,
      recommendationsGenerated,
    });
  } catch (err) {
    logger.error('Evolution pipeline failed', { error: String(err) });
    return res.status(500).json({ error: 'Pipeline execution failed' });
  }
});

router.get('/evolution/scheduler/status', requireAuth, requirePlatformAdmin, async (_req, res) => {
  return res.json({
    schedulerRunning: isSchedulerRunning(),
    pipelineRunning: isPipelineRunning(),
  });
});

router.post('/evolution/scheduler/start', requireAuth, requirePlatformAdmin, async (req, res) => {
  const intervalHours = parseInt(String(req.body?.intervalHours || '6'), 10);
  startEvolutionScheduler(intervalHours * 60 * 60 * 1000);
  logger.info('Evolution scheduler started via API', { intervalHours });
  return res.json({ success: true, intervalHours });
});

router.post('/evolution/scheduler/stop', requireAuth, requirePlatformAdmin, async (_req, res) => {
  stopEvolutionScheduler();
  logger.info('Evolution scheduler stopped via API');
  return res.json({ success: true });
});

export default router;
