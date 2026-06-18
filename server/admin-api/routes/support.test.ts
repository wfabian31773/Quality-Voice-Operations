import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'me@x.com', role: 'operations_manager', isPlatformAdmin: true },
  poolQueryMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// requirePlatformAdmin from ../middleware/rbac stays real.
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock }) }));
vi.mock('../../../platform/email/EmailService', () => ({ sendEmail: a.sendEmailMock }));
vi.mock('../../../platform/email/SupportEmailSuppression', () => ({
  addSupportEmailSuppression: vi.fn(), addSupportEmailSuppressionStrict: vi.fn(), addSupportEmailUnsubscribe: vi.fn(),
  checkSupportEmailSkip: vi.fn().mockResolvedValue({ skip: false }), getSupportEmailSuppression: vi.fn(),
  getSupportEmailSuppressionsByEmails: vi.fn().mockResolvedValue([]), removeSupportEmailSuppression: vi.fn(),
  removeSupportEmailSuppressionStrict: vi.fn(), removeSupportEmailUnsubscribe: vi.fn(),
}));
vi.mock('../../../platform/email/supportUnsubscribeToken', () => ({
  buildSupportUnsubscribeEmailHeaders: () => ({}), buildSupportUnsubscribeFooter: () => '',
  buildSupportUnsubscribeToken: () => 'tok', isSupportUnsubscribeMailtoTarget: () => false,
  verifySupportUnsubscribeToken: () => null,
}));
vi.mock('../../../platform/email/smtpErrorClass', () => ({ isPermanentSmtpError: () => false, isReplyPermanentFailure: () => false }));
vi.mock('../../../platform/help/DocsFeedbackAlertScheduler', () => ({ runDocsFeedbackAlertCycle: vi.fn(), runDocsFeedbackPendingReplyAlertCycle: vi.fn() }));
vi.mock('../../../platform/help/DocsFeedbackReplyDigestScheduler', () => ({ runDocsFeedbackReplyDigestCycle: vi.fn() }));
vi.mock('../../../platform/help/supportReplyEmail', () => ({
  buildReplyToAddress: () => 'reply@x.com', generateInboundToken: () => 'inb', renderOutboundTicketReplyEmail: () => ({ subject: 's', html: 'h', text: 't' }), escapeHtml: (s: string) => s,
}));
vi.mock('../../../platform/help/docsFeedbackReplyEmail', () => ({ renderDocsFeedbackReplyEmail: () => ({ subject: 's', html: 'h', text: 't' }) }));
vi.mock('../../../platform/help/docsFeedbackRetryLimiter', () => ({ tryReserveRetrySlot: vi.fn().mockResolvedValue(true), getRetryCooldownSeconds: () => 0 }));
vi.mock('../../../platform/help/supportReplyRetryLimiter', () => ({ tryReserveSupportReplyRetrySlot: vi.fn().mockResolvedValue(true), getSupportReplyRetryCooldownSeconds: () => 0 }));
vi.mock('../../../platform/core/observability', () => ({ logError: vi.fn() }));
vi.mock('../../../platform/help/supportReplyDeliveryAlert', () => ({
  REPLY_DELIVERY_ALERT_THRESHOLD: 3, raiseRecipientFirstBounceAlert: vi.fn(), raiseReplyDeliveryFailureAlert: vi.fn(),
}));

import router from './support';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.sendEmailMock.mockReset().mockResolvedValue({ success: true });
});

describe('POST /docs/feedback (public)', () => {
  it('requires an article_slug', async () => {
    expect((await request(app()).post('/docs/feedback').send({ vote: 'helpful' })).status).toBe(400);
  });
  it('requires a valid vote', async () => {
    expect((await request(app()).post('/docs/feedback').send({ article_slug: 'a', vote: 'maybe' })).status).toBe(400);
  });
  it('rejects an over-long comment', async () => {
    const res = await request(app()).post('/docs/feedback').send({ article_slug: 'a', vote: 'helpful', comment: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
  });
  it('rejects an invalid reply_email', async () => {
    const res = await request(app()).post('/docs/feedback').send({ article_slug: 'a', vote: 'helpful', reply_email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
  it('records valid feedback', async () => {
    const res = await request(app()).post('/docs/feedback').send({ article_slug: 'a', vote: 'helpful', comment: 'nice' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('POST /support/tickets', () => {
  it('requires a message', async () => {
    expect((await request(app()).post('/support/tickets').send({ topic: 'question' })).status).toBe(400);
  });
  it('rejects an over-long message', async () => {
    expect((await request(app()).post('/support/tickets').send({ message: 'x'.repeat(10001) })).status).toBe(400);
  });
});

describe('platform-admin gate', () => {
  it('rejects a non-platform-admin', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/support/routing')).status).toBe(403);
  });
});

describe('GET /support/routing', () => {
  it('lists routing rules', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 1, plan: 'pro', topic: 'billing', destination: 'x@x.com' }] });
    const res = await request(app()).get('/support/routing');
    expect(res.status).toBe(200);
    expect(res.body.routing).toHaveLength(1);
  });
  it('500 on a query failure', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/support/routing')).status).toBe(500);
  });
});

describe('PUT /support/routing/:id', () => {
  it('requires a destination', async () => {
    expect((await request(app()).put('/support/routing/1').send({})).status).toBe(400);
  });
  it('404 when the routing row is missing', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await request(app()).put('/support/routing/1').send({ destination: 'x@x.com' })).status).toBe(404);
  });
  it('updates the routing row', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 1, destination: 'x@x.com' }], rowCount: 1 });
    expect((await request(app()).put('/support/routing/1').send({ destination: 'x@x.com' })).status).toBe(200);
  });
});

describe('GET /support/tickets', () => {
  it('rejects an invalid status filter', async () => {
    expect((await request(app()).get('/support/tickets?status=weird')).status).toBe(400);
  });
  it('lists tickets', async () => {
    expect((await request(app()).get('/support/tickets')).status).toBe(200);
  });
});

describe('GET /support/tickets/stats', () => {
  it('returns ticket stats', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ total: 5, open: 2, email_failed: 0, email_failed_open: 0, reply_email_failed: 0, reply_email_failed_open: 0 }] });
    expect((await request(app()).get('/support/tickets/stats')).status).toBe(200);
  });
});

describe('GET /docs/feedback/summary', () => {
  it('aggregates feedback', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ article_slug: 'a', total_votes: 3, helpful_count: 2 }] });
    expect((await request(app()).get('/docs/feedback/summary')).status).toBe(200);
  });
});
