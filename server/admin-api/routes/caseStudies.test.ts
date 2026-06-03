import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  checkMilestonesMock: vi.fn(),
  generateCaseStudyMock: vi.fn(),
  getCaseStudiesMock: vi.fn(),
  getPublicCaseStudyMock: vi.fn(),
  getPublishedCaseStudiesMock: vi.fn(),
  updateCaseStudyStatusMock: vi.fn(),
  checkAllTenantMilestonesMock: vi.fn(),
  getTenantMilestoneConfigMock: vi.fn(),
  setTenantMilestonesMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/analytics/CaseStudyService', () => ({
  checkMilestones: a.checkMilestonesMock,
  generateCaseStudy: a.generateCaseStudyMock,
  getCaseStudies: a.getCaseStudiesMock,
  getPublicCaseStudy: a.getPublicCaseStudyMock,
  getPublishedCaseStudies: a.getPublishedCaseStudiesMock,
  updateCaseStudyStatus: a.updateCaseStudyStatusMock,
  checkAllTenantMilestones: a.checkAllTenantMilestonesMock,
  getTenantMilestoneConfig: a.getTenantMilestoneConfigMock,
  setTenantMilestones: a.setTenantMilestonesMock,
}));

import caseStudiesRouter from './caseStudies';

function app() {
  const app = express();
  app.use(express.json());
  app.use(caseStudiesRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.isPlatformAdmin = false;
  for (const [k, v] of Object.entries(a)) {
    if (k !== 'user' && typeof v === 'function' && 'mockReset' in v) (v as ReturnType<typeof vi.fn>).mockReset();
  }
  a.getCaseStudiesMock.mockResolvedValue([]);
  a.getTenantMilestoneConfigMock.mockResolvedValue({ milestones: [] });
  a.setTenantMilestonesMock.mockResolvedValue(undefined);
  a.checkMilestonesMock.mockResolvedValue([]);
  a.getPublishedCaseStudiesMock.mockResolvedValue([]);
});

describe('GET /case-studies', () => {
  it('lists case studies', async () => {
    a.getCaseStudiesMock.mockResolvedValue([{ id: 'cs1' }]);
    expect((await request(app()).get('/case-studies')).body).toEqual([{ id: 'cs1' }]);
  });

  it('returns 500 on failure', async () => {
    a.getCaseStudiesMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/case-studies')).status).toBe(500);
  });
});

describe('milestone config', () => {
  it('returns config for a manager', async () => {
    a.getTenantMilestoneConfigMock.mockResolvedValue({ milestones: [{ type: 'call_volume' }] });
    expect((await request(app()).get('/case-studies/milestones')).status).toBe(200);
  });

  it('rejects a viewer from milestone config', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/case-studies/milestones')).status).toBe(403);
  });

  it('requires owner role to set milestones (manager 403)', async () => {
    expect((await request(app()).put('/case-studies/milestones').send({ milestones: [] })).status).toBe(403);
  });

  it('validates the milestones array', async () => {
    a.user.role = 'tenant_owner';
    expect((await request(app()).put('/case-studies/milestones').send({ milestones: 'no' })).status).toBe(400);
  });

  it('validates each milestone shape', async () => {
    a.user.role = 'tenant_owner';
    const res = await request(app()).put('/case-studies/milestones').send({ milestones: [{ type: 'bogus', value: 1, label: 'x' }] });
    expect(res.status).toBe(400);
  });

  it('saves valid milestones', async () => {
    a.user.role = 'tenant_owner';
    const res = await request(app()).put('/case-studies/milestones').send({
      milestones: [{ type: 'call_volume', value: 1000, label: '1k calls' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 1 });
  });
});

describe('POST /case-studies/check-milestones', () => {
  it('generates case studies for hit milestones', async () => {
    a.checkMilestonesMock.mockResolvedValue([{ type: 'call_volume' }, { type: 'cost_savings' }]);
    a.generateCaseStudyMock.mockResolvedValueOnce({ id: 'cs1' }).mockResolvedValueOnce(null);
    const res = await request(app()).post('/case-studies/check-milestones');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ milestones: 2 });
    expect(res.body.generated).toHaveLength(1);
  });
});

describe('PATCH /case-studies/:id/status', () => {
  beforeEach(() => { a.user.role = 'tenant_owner'; });

  it('rejects an invalid status', async () => {
    expect((await request(app()).patch('/case-studies/cs1/status').send({ status: 'weird' })).status).toBe(400);
  });

  it('updates the status', async () => {
    a.updateCaseStudyStatusMock.mockResolvedValue({ id: 'cs1', status: 'published' });
    const res = await request(app()).patch('/case-studies/cs1/status').send({ status: 'published' });
    expect(res.status).toBe(200);
  });

  it('returns 404 when not found', async () => {
    a.updateCaseStudyStatusMock.mockResolvedValue(null);
    expect((await request(app()).patch('/case-studies/missing/status').send({ status: 'approved' })).status).toBe(404);
  });
});

describe('POST /case-studies/check-all-milestones', () => {
  it('requires platform admin even for a manager', async () => {
    expect((await request(app()).post('/case-studies/check-all-milestones')).status).toBe(403);
  });

  it('runs the global check for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    a.checkAllTenantMilestonesMock.mockResolvedValue([{ tenantId: 't1' }]);
    const res = await request(app()).post('/case-studies/check-all-milestones');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });
});

describe('public case-study endpoints', () => {
  it('lists published case studies', async () => {
    a.getPublishedCaseStudiesMock.mockResolvedValue([{ id: 'cs1' }]);
    expect((await request(app()).get('/public/case-studies')).body).toEqual([{ id: 'cs1' }]);
  });

  it('returns a single public case study by slug', async () => {
    a.getPublicCaseStudyMock.mockResolvedValue({ id: 'cs1', slug: 'acme' });
    expect((await request(app()).get('/public/case-studies/acme')).body).toMatchObject({ slug: 'acme' });
  });

  it('returns 404 for an unknown slug', async () => {
    a.getPublicCaseStudyMock.mockResolvedValue(null);
    expect((await request(app()).get('/public/case-studies/missing')).status).toBe(404);
  });
});
