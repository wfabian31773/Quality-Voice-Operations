import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  poolQueryMock: vi.fn(),
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  svc: Object.fromEntries([
    'getTemplate', 'installTemplate', 'listInstallations', 'updateInstallation',
    'checkEntitlement', 'getChecklistState', 'markStepComplete', 'markStepIncomplete',
    'buildCustomizationSchema', 'validateCustomizationUpdate',
    'isNewerVersion', 'getUpgradeType', 'isMajorUpgrade', 'validateVersionFormat',
    'runPrePublicationValidation', 'validateUpgradeCompatibility',
    'createReview', 'getReviewsForTemplate', 'deleteReview', 'moderateReview',
    'createMarketplacePurchase', 'checkPurchaseAccess', 'getRevenueStats', 'reportUsage',
    'listPurchasesForTenant', 'listInvoicesForPurchase',
    'createSubmission', 'listSubmissions', 'listReviewers', 'reviewSubmission',
    'getDeveloperStats', 'validateSubmission',
  ].map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// requireRole / requirePlatformAdmin from ../middleware/rbac stay real.
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({
    query: a.poolQueryMock,
    connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }),
  }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));

vi.mock('../../../platform/marketplace/InstallationService', () => ({
  getTemplate: a.svc.getTemplate,
  installTemplate: a.svc.installTemplate,
  listInstallations: a.svc.listInstallations,
  updateInstallation: a.svc.updateInstallation,
}));
vi.mock('../../../platform/marketplace/EntitlementService', () => ({ checkEntitlement: a.svc.checkEntitlement }));
vi.mock('../../../platform/marketplace/ChecklistService', () => ({
  getChecklistState: a.svc.getChecklistState,
  markStepComplete: a.svc.markStepComplete,
  markStepIncomplete: a.svc.markStepIncomplete,
  normalizeChecklistLocale: (l: string) => l ?? 'en',
}));
vi.mock('../../../platform/marketplace/CustomizationSchema', () => ({
  buildCustomizationSchema: a.svc.buildCustomizationSchema,
  validateCustomizationUpdate: a.svc.validateCustomizationUpdate,
}));
vi.mock('../../../platform/agent-templates/versioningService', () => ({
  isNewerVersion: a.svc.isNewerVersion,
  getUpgradeType: a.svc.getUpgradeType,
  isMajorUpgrade: a.svc.isMajorUpgrade,
  validateVersionFormat: a.svc.validateVersionFormat,
  runPrePublicationValidation: a.svc.runPrePublicationValidation,
  validateUpgradeCompatibility: a.svc.validateUpgradeCompatibility,
}));
vi.mock('../../../platform/marketplace/MarketplaceReviewService', () => ({
  createReview: a.svc.createReview,
  getReviewsForTemplate: a.svc.getReviewsForTemplate,
  deleteReview: a.svc.deleteReview,
  moderateReview: a.svc.moderateReview,
}));
vi.mock('../../../platform/marketplace/MarketplacePurchaseService', () => ({
  createMarketplacePurchase: a.svc.createMarketplacePurchase,
  checkPurchaseAccess: a.svc.checkPurchaseAccess,
  getRevenueStats: a.svc.getRevenueStats,
  reportUsage: a.svc.reportUsage,
  listPurchasesForTenant: a.svc.listPurchasesForTenant,
  listInvoicesForPurchase: a.svc.listInvoicesForPurchase,
}));
vi.mock('../../../platform/marketplace/DeveloperSubmissionService', () => ({
  createSubmission: a.svc.createSubmission,
  listSubmissions: a.svc.listSubmissions,
  listReviewers: a.svc.listReviewers,
  reviewSubmission: a.svc.reviewSubmission,
  getDeveloperStats: a.svc.getDeveloperStats,
  validateSubmission: a.svc.validateSubmission,
}));

import router from './marketplace';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.isPlatformAdmin = false;
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  for (const k of Object.keys(a.svc)) a.svc[k].mockReset();
});

describe('GET /marketplace/templates', () => {
  it('lists templates with pagination', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*)') ? { rows: [{ total: 1 }] } : { rows: [{ id: 'tpl1', display_name: 'Reception' }] },
    );
    const res = await request(app()).get('/marketplace/templates?search=front&sort=rating');
    expect(res.status).toBe(200);
    expect(res.body.templates[0]).toMatchObject({ id: 'tpl1', displayName: 'Reception' });
    expect(res.body.pagination.total).toBe(1);
  });
  it('500 on a query failure', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/marketplace/templates')).status).toBe(500);
  });
});

describe('GET /marketplace/templates/:id', () => {
  it('404 when the template is missing', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/marketplace/templates/nope')).status).toBe(404);
  });
});

describe('GET /marketplace/categories', () => {
  it('lists categories', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 'c1', name: 'support', display_name: 'Support', template_count: 2 }] });
    const res = await request(app()).get('/marketplace/categories');
    expect(res.status).toBe(200);
    expect(res.body.categories[0]).toMatchObject({ name: 'support', templateCount: 2 });
  });
});

describe('GET /marketplace/installations', () => {
  it('lists installations', async () => {
    a.svc.listInstallations.mockResolvedValue([{ id: 'inst1' }]);
    expect((await request(app()).get('/marketplace/installations')).body.installations).toHaveLength(1);
  });
  it('500 on failure', async () => {
    a.svc.listInstallations.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/marketplace/installations')).status).toBe(500);
  });
});

describe('reviews', () => {
  it('lists reviews for a template', async () => {
    a.svc.getReviewsForTemplate.mockResolvedValue({ reviews: [], total: 0 });
    expect((await request(app()).get('/marketplace/templates/tpl1/reviews')).status).toBe(200);
  });
  it('rejects a review without a rating', async () => {
    expect((await request(app()).post('/marketplace/templates/tpl1/reviews').send({})).status).toBe(400);
  });
  it('creates a review', async () => {
    a.svc.createReview.mockResolvedValue({ success: true, review: { id: 'r1' } });
    const res = await request(app()).post('/marketplace/templates/tpl1/reviews').send({ rating: 5, reviewText: 'great' });
    expect(res.status).toBe(201);
    expect(res.body.review).toMatchObject({ id: 'r1' });
  });
  it('400 when the review service rejects', async () => {
    a.svc.createReview.mockResolvedValue({ success: false, error: 'already reviewed' });
    expect((await request(app()).post('/marketplace/templates/tpl1/reviews').send({ rating: 3 })).status).toBe(400);
  });
  it('deletes a review', async () => {
    a.svc.deleteReview.mockResolvedValue({ success: true });
    expect((await request(app()).delete('/marketplace/reviews/r1')).body).toEqual({ success: true });
  });
  it('404 deleting a missing review', async () => {
    a.svc.deleteReview.mockResolvedValue({ success: false, error: 'not found' });
    expect((await request(app()).delete('/marketplace/reviews/r1')).status).toBe(404);
  });
});

describe('install (requireRole manager)', () => {
  it('rejects a viewer role', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/marketplace/templates/tpl1/install').send({})).status).toBe(403);
  });
  it('403 when a purchase is required', async () => {
    a.svc.checkPurchaseAccess.mockResolvedValue({ hasAccess: false });
    expect((await request(app()).post('/marketplace/templates/tpl1/install').send({})).status).toBe(403);
  });
  it('installs the template + audit', async () => {
    a.svc.checkPurchaseAccess.mockResolvedValue({ hasAccess: true });
    a.svc.installTemplate.mockResolvedValue({ success: true, installation: { id: 'inst1', agentId: 'ag1', templateVersion: '1.0.0' } });
    const res = await request(app()).post('/marketplace/templates/tpl1/install').send({ name: 'My Agent' });
    expect(res.status).toBe(201);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'marketplace.template_installed' }));
  });
  it('400 on an empty name', async () => {
    expect((await request(app()).post('/marketplace/templates/tpl1/install').send({ name: '  ' })).status).toBe(400);
  });
});

describe('purchases', () => {
  it('lists purchases', async () => {
    a.svc.listPurchasesForTenant.mockResolvedValue([{ id: 'p1' }]);
    expect((await request(app()).get('/marketplace/purchases')).body.purchases).toHaveLength(1);
  });
  it('creates a checkout session', async () => {
    a.svc.createMarketplacePurchase.mockResolvedValue({ success: true, checkoutUrl: 'https://pay', purchaseId: 'p1', isFree: false });
    const res = await request(app()).post('/marketplace/templates/tpl1/purchase').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checkoutUrl: 'https://pay', purchaseId: 'p1' });
  });
  it('400 when the purchase service rejects', async () => {
    a.svc.createMarketplacePurchase.mockResolvedValue({ success: false, error: 'not for sale' });
    expect((await request(app()).post('/marketplace/templates/tpl1/purchase').send({})).status).toBe(400);
  });
});

describe('platform-admin routes', () => {
  it('rejects a non-admin on revenue', async () => {
    expect((await request(app()).get('/platform/marketplace/revenue')).status).toBe(403);
  });
  it('returns revenue stats for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    a.svc.getRevenueStats.mockResolvedValue({ totalRevenue: 1000, platformFees: 100, developerPayouts: 900, purchaseCount: 5, byTemplate: [], recentEvents: [] });
    const res = await request(app()).get('/platform/marketplace/revenue');
    expect(res.status).toBe(200);
    expect(res.body.revenue).toMatchObject({ totalRevenueCents: 1000, totalPurchases: 5 });
  });
  it('rejects a non-admin on template versions', async () => {
    expect((await request(app()).get('/platform/templates/tpl1/versions')).status).toBe(403);
  });
  it('lists template versions for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 'v1', version: '1.0.0', is_latest: true }] });
    const res = await request(app()).get('/platform/templates/tpl1/versions');
    expect(res.status).toBe(200);
    expect(res.body.versions[0]).toMatchObject({ version: '1.0.0', isLatest: true });
  });
});
