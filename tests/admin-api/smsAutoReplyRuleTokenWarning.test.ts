import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { SMS_CANNED_RESPONSE_TOKENS } from '../../shared/sms/cannedResponseTokens';

const createAutoReplyRuleMock = vi.fn();
const updateAutoReplyRuleMock = vi.fn();
const writeAuditLogMock = vi.fn();

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
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  extractIp: () => '127.0.0.1',
}));
vi.mock('../../platform/sms/SmsConversationService', () => ({
  createAutoReplyRule: (...args: unknown[]) => createAutoReplyRuleMock(...args),
  updateAutoReplyRule: (...args: unknown[]) => updateAutoReplyRuleMock(...args),
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
  createAutoReplyRuleMock.mockReset();
  updateAutoReplyRuleMock.mockReset();
  writeAuditLogMock.mockReset();
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
  method: 'post' | 'patch',
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

describe('SMS auto-reply rule handlers reject unknown merge tokens', () => {
  it('POST /sms-inbox/auto-reply-rules returns 400 for an unknown replyBody token', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/sms-inbox/auto-reply-rules');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      body: {
        name: 'After-hours auto reply',
        ruleType: 'business_hours',
        replyBody: 'Hi {{custmer_name}}, we are closed.',
      },
      params: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createAutoReplyRuleMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as {
      error: string;
      unknownTokens: string[];
      knownTokens: readonly string[];
    };
    expect(payload.unknownTokens).toEqual(['custmer_name']);
    expect(payload.knownTokens).toEqual(SMS_CANNED_RESPONSE_TOKENS);
    expect(payload.error).toContain('{{custmer_name}}');
    expect(payload.error).toContain('{{contact_name}}');
  });

  it('POST /sms-inbox/auto-reply-rules flags malformed token shapes', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/sms-inbox/auto-reply-rules');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      body: {
        name: 'Greeting',
        ruleType: 'keyword',
        keyword: 'hi',
        replyBody: 'Hi {{contact-name}} / {{ contact name }}',
      },
      params: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createAutoReplyRuleMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { unknownTokens: string[] };
    expect(payload.unknownTokens).toEqual(['contact-name', 'contact name']);
  });

  it('POST /sms-inbox/auto-reply-rules inserts when every token is in the allowlist', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/sms-inbox/auto-reply-rules');

    createAutoReplyRuleMock.mockResolvedValueOnce({ id: 'rule-1', name: 'After-hours' });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      body: {
        name: 'After-hours',
        ruleType: 'business_hours',
        replyBody: 'Hi {{contact_name}} — {{agent_name}} will follow up.',
      },
      params: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createAutoReplyRuleMock).toHaveBeenCalledTimes(1);
  });

  it('POST /sms-inbox/auto-reply-rules still requires name and replyBody before token validation', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/sms-inbox/auto-reply-rules');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      body: { name: 'After-hours' },
      params: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createAutoReplyRuleMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { error: string };
    expect(payload.error).toMatch(/name and replyBody/);
  });

  it('PATCH /sms-inbox/auto-reply-rules/:id returns 400 for an unknown replyBody token', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'patch', '/sms-inbox/auto-reply-rules/:id');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: { id: 'rule-1' },
      body: { replyBody: 'Hello {{custmer_name}}' },
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(updateAutoReplyRuleMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { unknownTokens: string[] };
    expect(payload.unknownTokens).toEqual(['custmer_name']);
  });

  it('PATCH /sms-inbox/auto-reply-rules/:id skips token validation when replyBody is absent', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'patch', '/sms-inbox/auto-reply-rules/:id');

    updateAutoReplyRuleMock.mockResolvedValueOnce({ id: 'rule-1', enabled: false });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: { id: 'rule-1' },
      body: { enabled: false },
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(updateAutoReplyRuleMock).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ rule: { id: 'rule-1', enabled: false } });
  });

  it('PATCH /sms-inbox/auto-reply-rules/:id accepts a clean replyBody update', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'patch', '/sms-inbox/auto-reply-rules/:id');

    updateAutoReplyRuleMock.mockResolvedValueOnce({ id: 'rule-1' });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: { id: 'rule-1' },
      body: { replyBody: 'Hi {{contact_name}} — {{agent_name}} here.' },
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(updateAutoReplyRuleMock).toHaveBeenCalledTimes(1);
  });
});
