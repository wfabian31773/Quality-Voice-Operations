import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

// ---- Static contract checks -------------------------------------------------
//
// These guard the wire shape between the support inbox UI and the admin API.
// The "Hard bounces only" filter mirrors the existing docs-feedback "Failed
// only" toggle: the server endpoint accepts a `reply_state` query param, and
// the stats endpoint surfaces a hard-bounce subset count so the banner can
// call it out before the admin even toggles the filter.

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);

describe('/support/tickets — hard-bounce filter contract', () => {
  it('imports the shared SMTP error classifier so server + client agree on the verdict', () => {
    expect(supportFile).toMatch(
      /from '\.\.\/\.\.\/\.\.\/platform\/email\/smtpErrorClass'/,
    );
    expect(supportFile).toMatch(/isPermanentSmtpError/);
  });

  it('accepts a reply_state query param and rejects unknown values', () => {
    expect(supportFile).toMatch(/req\.query\.reply_state/);
    expect(supportFile).toMatch(/'hard_bounce'/);
    expect(supportFile).toMatch(/invalid reply_state filter/);
  });

  it('LATERAL-joins the latest outbound reply so the UI gets the most recent reply error per ticket', () => {
    expect(supportFile).toMatch(/LEFT JOIN LATERAL/);
    expect(supportFile).toMatch(/last_outbound_reply_error/);
    expect(supportFile).toMatch(/last_outbound_reply_at/);
    // The lateral subquery filters to outbound replies only — inbound replies
    // are never an "admin send" failure so they must not feed the badge.
    expect(supportFile).toMatch(/direction = 'outbound'/);
  });
});

describe('/support/tickets/stats — exposes hard-bounce subset counts', () => {
  it('returns hard_bounce and hard_bounce_open alongside the existing fields', () => {
    expect(supportFile).toMatch(/hard_bounce:\s*hardBounce/);
    expect(supportFile).toMatch(/hard_bounce_open:\s*hardBounceOpen/);
  });

  it('classifies via the shared isPermanentSmtpError helper, not ad-hoc string matching', () => {
    expect(supportFile).toMatch(/isPermanentSmtpError\(row\.latest_error\)/);
  });
});

describe('PlatformAdmin SupportInboxTab — hard bounces only filter', () => {
  it('reads the new hard_bounce fields from the stats payload', () => {
    expect(adminUiFile).toMatch(/hard_bounce:\s*number/);
    expect(adminUiFile).toMatch(/hard_bounce_open:\s*number/);
  });

  it('sends reply_state=hard_bounce when the toggle is on', () => {
    expect(adminUiFile).toMatch(/reply_state.{0,30}hard_bounce/);
  });

  it('renders a "Hard bounces only" filter checkbox', () => {
    expect(adminUiFile).toMatch(/Hard bounces only/);
  });

  it('mentions the hard-bounce subset count in the reply-failure banner', () => {
    expect(adminUiFile).toMatch(/hard bounce/);
  });
});

// ---- Runtime behavior -------------------------------------------------------
//
// Mock the platform DB and stub auth/RBAC so we can exercise the route
// directly. The interesting paths are:
//   1. /support/tickets?reply_state=hard_bounce post-filters with the JS
//      classifier and respects the requested limit
//   2. /support/tickets/stats counts hard bounces using both the latest
//      outbound reply (when present) and the initial routed send (when no
//      reply has gone out yet)

vi.mock('../../platform/db', () => {
  const queryMock = vi.fn();
  return {
    __queryMock: queryMock,
    getPlatformPool: () => ({ query: queryMock }),
  };
});

vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../platform/core/observability', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = {
      userId: '00000000-0000-0000-0000-000000000001',
      email: 'admin@qvo.ai',
      tenantId: null,
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requirePlatformAdmin: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock('../../platform/help/DocsFeedbackAlertScheduler', () => ({
  runDocsFeedbackAlertCycle: vi.fn(),
  runDocsFeedbackPendingReplyAlertCycle: vi.fn(),
}));
vi.mock('../../platform/help/DocsFeedbackReplyDigestScheduler', () => ({
  runDocsFeedbackReplyDigestCycle: vi.fn(),
}));

vi.mock('../../platform/help/supportReplyRetryLimiter', () => ({
  tryReserveSupportReplyRetrySlot: async () => ({ allowed: true as const }),
  getSupportReplyRetryCooldownSeconds: () => 0,
}));

const router = (await import('../../server/admin-api/routes/support')).default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = ((await import('../../platform/db')) as any).__queryMock as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /support/tickets?reply_state=hard_bounce — runtime filter', () => {
  it('keeps tickets whose latest outbound reply is a permanent SMTP failure and drops the rest', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        // Hard bounce on the most recent admin reply.
        {
          id: 'tkt_a', tenant_id: null, user_id: 'u', user_email: 'a@x.com',
          plan: 'trial', topic: 'bug', message: 'm', recent_errors: null,
          context: {}, routed_to: 'support@qvo.ai', status: 'open',
          email_message_id: null, email_error: null,
          created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
          tenant_name: null,
          last_outbound_reply_error: '550 5.1.1 mailbox not found',
          last_outbound_reply_at: '2024-01-02T00:00:00Z',
        },
        // Transient error on latest reply — must NOT match.
        {
          id: 'tkt_b', tenant_id: null, user_id: 'u', user_email: 'b@x.com',
          plan: 'trial', topic: 'bug', message: 'm', recent_errors: null,
          context: {}, routed_to: 'support@qvo.ai', status: 'open',
          email_message_id: null, email_error: null,
          created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
          tenant_name: null,
          last_outbound_reply_error: 'connection timed out',
          last_outbound_reply_at: '2024-01-02T00:00:00Z',
        },
        // No outbound reply yet — falls back to the initial send error,
        // which IS a hard bounce.
        {
          id: 'tkt_c', tenant_id: null, user_id: 'u', user_email: 'c@x.com',
          plan: 'trial', topic: 'bug', message: 'm', recent_errors: null,
          context: {}, routed_to: 'support@qvo.ai', status: 'open',
          email_message_id: null, email_error: '550 user unknown',
          created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
          tenant_name: null,
          last_outbound_reply_error: null,
          last_outbound_reply_at: null,
        },
        // No outbound reply, initial send succeeded — must NOT match.
        {
          id: 'tkt_d', tenant_id: null, user_id: 'u', user_email: 'd@x.com',
          plan: 'trial', topic: 'bug', message: 'm', recent_errors: null,
          context: {}, routed_to: 'support@qvo.ai', status: 'open',
          email_message_id: 'msg_1', email_error: null,
          created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
          tenant_name: null,
          last_outbound_reply_error: null,
          last_outbound_reply_at: null,
        },
      ],
    });

    const res = await request(buildApp())
      .get('/support/tickets?status=all&reply_state=hard_bounce&limit=200');

    expect(res.status).toBe(200);
    const ids = res.body.tickets.map((t: { id: string }) => t.id);
    expect(ids).toEqual(['tkt_a', 'tkt_c']);
  });

  it('rejects unknown reply_state values with a 400', async () => {
    const res = await request(buildApp())
      .get('/support/tickets?reply_state=bogus');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reply_state/);
  });
});

describe('GET /support/tickets/stats — hard-bounce counts', () => {
  it('counts hard bounces using the latest outbound reply when present, else the initial send', async () => {
    // First query: the existing aggregate stats (totals + reply failures).
    queryMock.mockResolvedValueOnce({
      rows: [{
        total: 4,
        open: 4,
        email_failed: 2,
        email_failed_open: 2,
        reply_email_failed: 1,
        reply_email_failed_open: 1,
      }],
    });
    // Second query: candidate failures the JS classifier walks. Mix of:
    //  - latest reply hard bounce (counts)           → tkt_a / open
    //  - latest reply transient error (excluded)     → tkt_b
    //  - no reply, initial send hard bounce (counts) → tkt_c / resolved
    //  - no reply, initial send transient (excluded) → tkt_d
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'tkt_a', status: 'open',       latest_error: '550 mailbox not found' },
        { id: 'tkt_b', status: 'open',       latest_error: '421 try later' },
        { id: 'tkt_c', status: 'resolved',   latest_error: '550 user unknown' },
        { id: 'tkt_d', status: 'in_progress', latest_error: 'temporary failure' },
      ],
    });

    const res = await request(buildApp()).get('/support/tickets/stats');

    expect(res.status).toBe(200);
    expect(res.body.hard_bounce).toBe(2);
    // Only tkt_a is hard-bounce + open/in_progress; tkt_c is resolved.
    expect(res.body.hard_bounce_open).toBe(1);
    // Existing fields still flow through.
    expect(res.body.reply_email_failed).toBe(1);
    expect(res.body.email_failed).toBe(2);
  });
});
