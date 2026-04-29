/**
 * Coverage for the deferred-SMS counter (task #989).
 *
 * The scheduled SMS dispatcher pushes any send that lands inside a
 * recipient's TCPA quiet-hours window to the next 8am-local instead of
 * dropping it (see `processScheduledMessages` in
 * `server/admin-api/routes/smsInbox.ts`). Operators previously had no
 * visibility into how many texts were queued behind that defer logic —
 * they had to read server logs or scroll through per-conversation
 * activity entries. This test pins down the new surface that lets them
 * see the backlog directly:
 *
 *  - GET /sms-inbox/deferred returns the per-message defer entries the
 *    UI needs to draw the per-conversation badge.
 *  - GET /sms-inbox/threads?deferred=true narrows the conversation list
 *    to threads that currently have at least one parked message.
 *  - The handlers degrade gracefully (500 + JSON error) when the
 *    underlying service throws, so a bad query doesn't blank the
 *    inbox.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const listDeferredMessagesMock = vi.fn();
const listConversationsMock = vi.fn();
const getInboxCountsMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: vi.fn() }),
  withTenantContext: vi.fn(async () => {}),
  withPrivilegedClient: vi.fn(),
}));
vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));
vi.mock('../../platform/sms/SmsConversationService', () => ({
  listDeferredMessages: (...args: unknown[]) => listDeferredMessagesMock(...args),
  listConversations: (...args: unknown[]) => listConversationsMock(...args),
  getInboxCounts: (...args: unknown[]) => getInboxCountsMock(...args),
}));
vi.mock('../../platform/sms/SmsQuietHours', () => ({
  evaluateSmsQuietHours: vi.fn(),
  nextSmsWindowStart: vi.fn(),
  SMS_QUIET_HOURS_WINDOW_START: '08:00',
  SMS_QUIET_HOURS_WINDOW_END: '21:00',
}));
vi.mock('../../shared/sms/cannedResponseTokens', () => ({
  SMS_CANNED_RESPONSE_TOKENS: [],
  findUnknownSmsCannedResponseTokens: () => [],
}));
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: Request, _res: Response, next: () => void) => next(),
  requireRole: () => (_req: Request, _res: Response, next: () => void) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));

beforeEach(() => {
  listDeferredMessagesMock.mockReset();
  listConversationsMock.mockReset();
  getInboxCountsMock.mockReset();
  vi.resetModules();
});

interface JsonResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function buildRes(): JsonResponse & Response {
  const res: Partial<Response> & JsonResponse = {
    status: vi.fn().mockReturnThis() as unknown as ReturnType<typeof vi.fn>,
    json: vi.fn().mockReturnThis() as unknown as ReturnType<typeof vi.fn>,
  };
  return res as JsonResponse & Response;
}

async function loadRouter() {
  const mod = await import('../../server/admin-api/routes/smsInbox');
  return mod.default;
}

function findHandler(
  router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> }; handle: unknown }> },
  method: 'get' | 'post' | 'patch',
  path: string,
) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer || !layer.route) throw new Error(`No ${method.toUpperCase()} ${path} route`);
  const stack = (layer.route as unknown as { stack: Array<{ handle: unknown }> }).stack;
  return stack[stack.length - 1].handle as (
    req: Request,
    res: Response,
    next: () => void,
  ) => Promise<void>;
}

describe('GET /sms-inbox/deferred', () => {
  it('returns the deferred-SMS entries scoped to the caller tenant', async () => {
    listDeferredMessagesMock.mockResolvedValueOnce([
      {
        conversationId: 'conv-1',
        messageId: 'msg-1',
        deferredUntil: new Date('2026-04-30T13:00:00.000Z'),
        recipientTimezone: 'America/Los_Angeles',
        scheduledAt: new Date('2026-04-30T13:00:00.000Z'),
      },
      {
        conversationId: 'conv-2',
        messageId: 'msg-2',
        deferredUntil: null,
        recipientTimezone: null,
        scheduledAt: null,
      },
    ]);

    const router = await loadRouter();
    const handler = findHandler(router, 'get', '/sms-inbox/deferred');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: {},
      query: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(listDeferredMessagesMock).toHaveBeenCalledWith('tenant-A');
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0] as { deferred: Array<{ conversationId: string }> };
    expect(payload.deferred).toHaveLength(2);
    expect(payload.deferred[0].conversationId).toBe('conv-1');
  });

  it('responds with a 500 JSON envelope when the service throws', async () => {
    listDeferredMessagesMock.mockRejectedValueOnce(new Error('boom'));

    const router = await loadRouter();
    const handler = findHandler(router, 'get', '/sms-inbox/deferred');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: {},
      query: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0] as { error: string };
    expect(payload.error).toMatch(/deferred/i);
  });
});

describe('GET /sms-inbox/threads with deferred filter', () => {
  it('passes deferredOnly=true to the service when ?deferred=true is set', async () => {
    listConversationsMock.mockResolvedValueOnce({ conversations: [], total: 0 });

    const router = await loadRouter();
    const handler = findHandler(router, 'get', '/sms-inbox/threads');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: {},
      query: { deferred: 'true', limit: '50', page: '1' },
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(listConversationsMock).toHaveBeenCalledTimes(1);
    const opts = listConversationsMock.mock.calls[0][1] as { deferredOnly: boolean };
    expect(opts.deferredOnly).toBe(true);
  });

  it('omits the deferred filter when the query param is missing', async () => {
    // Defense against accidental opt-in: the existing behavior of
    // returning every conversation must keep working when the new
    // filter isn't requested.
    listConversationsMock.mockResolvedValueOnce({ conversations: [], total: 0 });

    const router = await loadRouter();
    const handler = findHandler(router, 'get', '/sms-inbox/threads');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: {},
      query: { limit: '50', page: '1' },
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(listConversationsMock).toHaveBeenCalledTimes(1);
    const opts = listConversationsMock.mock.calls[0][1] as { deferredOnly: boolean };
    expect(opts.deferredOnly).toBe(false);
  });
});

describe('GET /sms-inbox/counts', () => {
  it('forwards the deferred count from the service to the API payload', async () => {
    // The service-layer query (covered separately) is what actually
    // computes the deferred backlog. The route just re-shapes it; this
    // assertion guards against a refactor that drops the new field
    // before the UI gets a chance to render it.
    getInboxCountsMock.mockResolvedValueOnce({
      open: 3,
      pending: 1,
      closed: 0,
      escalated: 0,
      archived: 0,
      unread: 2,
      deferred: 7,
    });

    const router = await loadRouter();
    const handler = findHandler(router, 'get', '/sms-inbox/counts');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: {},
      query: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(getInboxCountsMock).toHaveBeenCalledWith('tenant-A');
    const payload = res.json.mock.calls[0][0] as { counts: Record<string, number> };
    expect(payload.counts.deferred).toBe(7);
  });
});
