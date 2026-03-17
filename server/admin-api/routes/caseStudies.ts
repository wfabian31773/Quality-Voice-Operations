import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import {
  checkMilestones,
  generateCaseStudy,
  getCaseStudies,
  getPublicCaseStudy,
  getPublishedCaseStudies,
  updateCaseStudyStatus,
  checkAllTenantMilestones,
  getTenantMilestoneConfig,
  setTenantMilestones,
} from '../../../platform/analytics/CaseStudyService';
import type { MilestoneThreshold } from '../../../platform/analytics/CaseStudyService';

const router = Router();
const logger = createLogger('CASE_STUDY_ROUTES');

router.get('/case-studies', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const studies = await getCaseStudies(tenantId);
    return res.json(studies);
  } catch (err) {
    logger.error('Failed to list case studies', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list case studies' });
  }
});

router.get('/case-studies/milestones', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const milestones = await getTenantMilestoneConfig(tenantId);
    return res.json(milestones);
  } catch (err) {
    logger.error('Failed to get milestone config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get milestone configuration' });
  }
});

router.put('/case-studies/milestones', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId } = req.user!;
  const { milestones } = req.body as { milestones?: MilestoneThreshold[] };

  if (!Array.isArray(milestones)) {
    return res.status(400).json({ error: 'milestones must be an array' });
  }

  const validTypes = ['call_volume', 'cost_savings', 'time_in_service'];
  for (const m of milestones) {
    if (!validTypes.includes(m.type) || typeof m.value !== 'number' || !m.label) {
      return res.status(400).json({ error: 'Each milestone must have a valid type, numeric value, and label' });
    }
  }

  try {
    await setTenantMilestones(tenantId, milestones);
    return res.json({ success: true, count: milestones.length });
  } catch (err) {
    logger.error('Failed to set milestone config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update milestone configuration' });
  }
});

router.post('/case-studies/check-milestones', requireAuth, requireRole('admin'), async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const milestones = await checkMilestones(tenantId);
    const generated = [];
    for (const m of milestones) {
      const study = await generateCaseStudy(tenantId, m);
      if (study) generated.push(study);
    }
    return res.json({ milestones: milestones.length, generated });
  } catch (err) {
    logger.error('Failed to check milestones', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to check milestones' });
  }
});

router.patch('/case-studies/:id/status', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { status } = req.body as { status?: string };

  if (!status || !['approved', 'published'].includes(status)) {
    return res.status(400).json({ error: 'Status must be "approved" or "published"' });
  }

  try {
    const study = await updateCaseStudyStatus(tenantId, id, status as 'approved' | 'published');
    if (!study) {
      return res.status(404).json({ error: 'Case study not found' });
    }
    return res.json(study);
  } catch (err) {
    logger.error('Failed to update case study status', { tenantId, id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

router.post('/case-studies/check-all-milestones', requireAuth, requireRole('admin'), async (req, res) => {
  if (!req.user!.isPlatformAdmin) {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  try {
    const results = await checkAllTenantMilestones();
    return res.json({ results });
  } catch (err) {
    logger.error('Failed to run global milestone check', { error: String(err) });
    return res.status(500).json({ error: 'Failed to check milestones' });
  }
});

router.get('/public/case-studies', async (_req, res) => {
  try {
    const studies = await getPublishedCaseStudies();
    return res.json(studies);
  } catch (err) {
    logger.error('Failed to list public case studies', { error: String(err) });
    return res.status(500).json({ error: 'Failed to list case studies' });
  }
});

router.get('/public/case-studies/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const study = await getPublicCaseStudy(slug);
    if (!study) {
      return res.status(404).json({ error: 'Case study not found' });
    }
    return res.json(study);
  } catch (err) {
    logger.error('Failed to get public case study', { slug, error: String(err) });
    return res.status(500).json({ error: 'Failed to get case study' });
  }
});

export default router;
