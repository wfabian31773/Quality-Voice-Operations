import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

// ---- Static contract checks -------------------------------------------------
//
// Lock down the wire shape between the new "Unsubscribed addresses" panel in
// PlatformAdmin and the admin API. The endpoint is purely a read surface
// over `support_email_unsubscribes`; the send-side gate
// (`checkSupportEmailSkip`) already enforces the list, so this contract
// keeps the discoverability panel agreeing with what the gate sees.

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);

describe('/support/unsubscribed — endpoint contract', () => {
  it('mounts the new GET endpoint guarded by requireAuth + requirePlatformAdmin', () => {
    expect(supportFile).toMatch(
      /router\.get\(\s*['"]\/support\/unsubscribed['"][\s\S]*?requireAuth[\s\S]*?requirePlatformAdmin/,
    );
  });

  it('reads from the support_email_unsubscribes table the gate already enforces', () => {
    const start = supportFile.indexOf("'/support/unsubscribed'");
    expect(start).toBeGreaterThan(-1);
    const after = supportFile.slice(start, start + 3000);
    expect(after).toMatch(/FROM support_email_unsubscribes/);
    expect(after).toMatch(/ORDER BY unsubscribed_at DESC/);
  });

  it('returns the same {records,total,truncated} shape as the bounced-recipients panel', () => {
    const start = supportFile.indexOf("'/support/unsubscribed'");
    const after = supportFile.slice(start, start + 3000);
    expect(after).toMatch(/unsubscribes:/);
    expect(after).toMatch(/total/);
    expect(after).toMatch(/truncated/);
  });
});

describe('PlatformAdmin SupportInboxTab — unsubscribed addresses panel', () => {
  it('renders an Unsubscribed addresses panel inside the support inbox', () => {
    expect(adminUiFile).toMatch(/UnsubscribedAddressesPanel/);
    expect(adminUiFile).toMatch(/Unsubscribed addresses/);
  });

  it('fetches /support/unsubscribed to populate the panel', () => {
    expect(adminUiFile).toMatch(/\/support\/unsubscribed/);
  });
});

// ---- Runtime behavior -------------------------------------------------------
//
// Mock the platform DB and stub auth/RBAC so we can exercise the route
// directly. Verifies:
//   1. Returns the rows from the table verbatim with a separate total count
//   2. `truncated` flips when total > returned slice
//   3. Empty table returns an empty list (not an error)
//   4. The `limit` query param is honored and clamped to a sane range
//   5. DB errors surface as a 500 with a detail string

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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
  __setCooldownSecondsForTesting: () => {},
  __reloadCooldownFromEnvForTesting: () => {},
  __resetForTesting: async () => {},
  getSupportReplyRetryCooldownSeconds: () => 0,
}));

const router = (await import('../../server/admin-api/routes/support')).default;
const queryMock = (
  (await import('../../platform/db')) as unknown as {
    __queryMock: ReturnType<typeof vi.fn>;
  }
).__queryMock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const PATH = '/support/unsubscribed';

beforeEach(() => {
  queryMock.mockReset();
});

// The handler issues two queries in parallel (`Promise.all`): the row slice
// and the count. Help the mock return the right value for each by branching
// on the SQL text.
function mockUnsubscribesAndCount(rows: unknown[], totalOverride?: number) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/i.test(sql)) {
      const total = totalOverride ?? rows.length;
      return { rowCount: 1, rows: [{ count: String(total) }] };
    }
    return { rowCount: rows.length, rows };
  });
}

describe('GET /support/unsubscribed — runtime behavior', () => {
  it('returns the unsubscribed rows ordered as the SQL emits them, with total + truncated=false', async () => {
    mockUnsubscribesAndCount([
      {
        email_lower: 'alice@example.com',
        source: 'list_unsubscribe_header',
        unsubscribed_at: '2026-04-26T12:00:00Z',
      },
      {
        email_lower: 'bob@example.com',
        source: 'landing_page',
        unsubscribed_at: '2026-04-25T08:30:00Z',
      },
    ]);

    const r = await request(buildApp()).get(PATH).send();
    expect(r.status).toBe(200);
    expect(r.body.unsubscribes).toHaveLength(2);
    expect(r.body.unsubscribes[0].email_lower).toBe('alice@example.com');
    expect(r.body.unsubscribes[0].source).toBe('list_unsubscribe_header');
    expect(r.body.unsubscribes[1].email_lower).toBe('bob@example.com');
    expect(r.body.total).toBe(2);
    expect(r.body.truncated).toBe(false);
  });

  it('flags truncated=true when the table has more rows than the returned slice', async () => {
    mockUnsubscribesAndCount(
      [
        {
          email_lower: 'one@example.com',
          source: null,
          unsubscribed_at: '2026-04-26T12:00:00Z',
        },
      ],
      // Pretend the table has 50 rows even though we only returned 1.
      50,
    );

    const r = await request(buildApp()).get(`${PATH}?limit=1`).send();
    expect(r.status).toBe(200);
    expect(r.body.unsubscribes).toHaveLength(1);
    expect(r.body.total).toBe(50);
    expect(r.body.truncated).toBe(true);
  });

  it('returns an empty list (not an error) when no addresses have unsubscribed', async () => {
    mockUnsubscribesAndCount([]);

    const r = await request(buildApp()).get(PATH).send();
    expect(r.status).toBe(200);
    expect(r.body.unsubscribes).toEqual([]);
    expect(r.body.total).toBe(0);
    expect(r.body.truncated).toBe(false);
  });

  it('passes the requested limit through to the SQL query', async () => {
    mockUnsubscribesAndCount([]);

    await request(buildApp()).get(`${PATH}?limit=25`).send();

    const sliceCall = queryMock.mock.calls.find(
      (call) => /FROM support_email_unsubscribes/i.test(call[0]) && !/COUNT/i.test(call[0]),
    );
    expect(sliceCall).toBeTruthy();
    // Second positional arg is the params array, holding [limit].
    expect(sliceCall?.[1]).toEqual([25]);
  });

  it('clamps an absurd limit down to the cap (500) before issuing the query', async () => {
    mockUnsubscribesAndCount([]);

    await request(buildApp()).get(`${PATH}?limit=99999`).send();

    const sliceCall = queryMock.mock.calls.find(
      (call) => /FROM support_email_unsubscribes/i.test(call[0]) && !/COUNT/i.test(call[0]),
    );
    expect(sliceCall?.[1]).toEqual([500]);
  });

  it('returns 500 with a detail message when the database query fails', async () => {
    queryMock.mockRejectedValue(new Error('boom'));

    const r = await request(buildApp()).get(PATH).send();
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Failed to load unsubscribed addresses/);
    expect(r.body.detail).toContain('boom');
  });
});
