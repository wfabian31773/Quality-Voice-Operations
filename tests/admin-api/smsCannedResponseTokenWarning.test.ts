// Verifies the shared SMS canned-response merge-token allowlist (task #806):
//   - findUnknownSmsCannedResponseTokens flags typos like {{custmer_name}}
//     while letting through every renderer-supported token (case-insensitive,
//     with or without inner whitespace), so the editor can warn agents
//     before a broken merge field reaches a customer.
//   - createCannedResponseHandler / updateCannedResponseHandler reject
//     saves whose body contains unknown tokens, so the editor warning
//     can't be bypassed by a direct API call.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import {
  SMS_CANNED_RESPONSE_TOKENS,
  findUnknownSmsCannedResponseTokens,
  isKnownSmsCannedResponseToken,
} from '../../shared/sms/cannedResponseTokens';

describe('findUnknownSmsCannedResponseTokens', () => {
  it('returns an empty array when every token is in the allowlist', () => {
    const body =
      'Hi {{contact_name}}, this is {{agent_name}} — your number on file is {{phone}}.';
    expect(findUnknownSmsCannedResponseTokens(body)).toEqual([]);
  });

  it('tolerates inner whitespace in the merge token braces', () => {
    expect(findUnknownSmsCannedResponseTokens('Hi {{ contact_name }}!')).toEqual([]);
  });

  it('accepts case variations because the renderer substitutes case-insensitively', () => {
    // useTemplate() in client-app/src/pages/SmsInbox.tsx substitutes with
    // the `gi` regex flag, so {{Name}}/{{NAME}} are valid renderer input.
    // Validation must mirror that or agents would see false positives.
    expect(findUnknownSmsCannedResponseTokens('Hi {{Name}} / {{NAME}} / {{Contact_Email}}')).toEqual([]);
  });

  it('flags typos and dedupes repeated unknown tokens in source order', () => {
    const body = 'Hi {{custmer_name}}, see {{custmer_name}} & {{phon}}';
    expect(findUnknownSmsCannedResponseTokens(body)).toEqual(['custmer_name', 'phon']);
  });

  it('flags malformed token shapes the renderer cannot substitute', () => {
    // Hyphens, dots, and inner spaces produce names the renderer's
    // substitution regex will not match, so they would silently leak
    // the raw braces to the customer if we let them through.
    const body =
      '{{contact-name}} | {{contact.name}} | {{ contact name }} | {{}} | {{contact_name}}';
    expect(findUnknownSmsCannedResponseTokens(body)).toEqual([
      'contact-name',
      'contact.name',
      'contact name',
    ]);
  });

  it('returns [] for non-string or empty inputs so callers can pass raw form state', () => {
    expect(findUnknownSmsCannedResponseTokens(undefined)).toEqual([]);
    expect(findUnknownSmsCannedResponseTokens(null)).toEqual([]);
    expect(findUnknownSmsCannedResponseTokens('')).toEqual([]);
    expect(findUnknownSmsCannedResponseTokens(42)).toEqual([]);
    expect(findUnknownSmsCannedResponseTokens({})).toEqual([]);
  });

  it('exports the full list of renderer-supported tokens', () => {
    // If this changes, useTemplate() in client-app/src/pages/SmsInbox.tsx
    // must add a value for the new token in its substitution map.
    expect(SMS_CANNED_RESPONSE_TOKENS).toEqual([
      'name',
      'phone',
      'contact_name',
      'contact_email',
      'contact_location',
      'agent_name',
    ]);
  });
});

describe('isKnownSmsCannedResponseToken', () => {
  it('recognizes every canonical token', () => {
    for (const token of SMS_CANNED_RESPONSE_TOKENS) {
      expect(isKnownSmsCannedResponseToken(token)).toBe(true);
    }
  });

  it('matches case-insensitively to mirror the renderer', () => {
    expect(isKnownSmsCannedResponseToken('NAME')).toBe(true);
    expect(isKnownSmsCannedResponseToken('Contact_Name')).toBe(true);
  });

  it('rejects unknown tokens', () => {
    expect(isKnownSmsCannedResponseToken('custmer_name')).toBe(false);
    expect(isKnownSmsCannedResponseToken('contact-name')).toBe(false);
  });
});

const createCannedResponseMock = vi.fn();
const updateCannedResponseMock = vi.fn();
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
  createCannedResponse: (...args: unknown[]) => createCannedResponseMock(...args),
  updateCannedResponse: (...args: unknown[]) => updateCannedResponseMock(...args),
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
  createCannedResponseMock.mockReset();
  updateCannedResponseMock.mockReset();
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
  // Routes wire several middlewares before the handler; the final one
  // is the actual handler we want to assert against.
  const stack = (layer.route as unknown as { stack: Array<{ handle: unknown }> }).stack;
  return stack[stack.length - 1].handle as (
    req: Request,
    res: Response,
    next: () => void,
  ) => Promise<void>;
}

describe('SMS canned-response handlers reject unknown merge tokens', () => {
  it('POST /sms-inbox/templates returns 400 for an unknown body token', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/sms-inbox/templates');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      body: {
        title: 'Quick reply',
        body: 'Hi {{custmer_name}}, your tech is on the way.',
      },
      params: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createCannedResponseMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as {
      error: string;
      unknownTokens: string[];
      knownTokens: readonly string[];
    };
    expect(payload.unknownTokens).toEqual(['custmer_name']);
    expect(payload.knownTokens).toEqual(SMS_CANNED_RESPONSE_TOKENS);
    expect(payload.error).toContain('{{custmer_name}}');
    // The error must list the supported tokens so an agent hitting this
    // via curl/Postman gets the same guidance the editor shows.
    expect(payload.error).toContain('{{contact_name}}');
  });

  it('POST /sms-inbox/templates flags malformed token shapes', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/sms-inbox/templates');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      body: {
        title: 'Quick reply',
        body: 'Hi {{contact-name}} / {{ contact name }}',
      },
      params: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createCannedResponseMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { unknownTokens: string[] };
    expect(payload.unknownTokens).toEqual(['contact-name', 'contact name']);
  });

  it('POST /sms-inbox/templates inserts when every token is in the allowlist', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/sms-inbox/templates');

    createCannedResponseMock.mockResolvedValueOnce({ id: 'tpl-1', title: 'Quick reply' });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      body: {
        title: 'Quick reply',
        body: 'Hi {{contact_name}}, this is {{agent_name}}.',
      },
      params: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createCannedResponseMock).toHaveBeenCalledTimes(1);
  });

  it('POST /sms-inbox/templates still requires title and body before token validation', async () => {
    // Sanity check that the existing 400 for missing fields still fires
    // even when token validation would otherwise pass. (Token validation
    // runs against `data.body`, so a missing body must be rejected first
    // for the right reason.)
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/sms-inbox/templates');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      body: { title: 'Quick reply' },
      params: {},
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createCannedResponseMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { error: string };
    expect(payload.error).toMatch(/title and body/);
  });

  it('PATCH /sms-inbox/templates/:id returns 400 for an unknown body token', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'patch', '/sms-inbox/templates/:id');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: { id: 'tpl-1' },
      body: { body: 'Hello {{custmer_name}}' },
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(updateCannedResponseMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { unknownTokens: string[] };
    expect(payload.unknownTokens).toEqual(['custmer_name']);
  });

  it('PATCH /sms-inbox/templates/:id skips token validation when body is absent', async () => {
    // Partial updates that only rename or recategorize a template must
    // still succeed — we only validate fields that are actually present
    // in the patch body.
    const router = await loadRouter();
    const handler = findHandler(router, 'patch', '/sms-inbox/templates/:id');

    updateCannedResponseMock.mockResolvedValueOnce({ id: 'tpl-1', title: 'Renamed' });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: { id: 'tpl-1' },
      body: { title: 'Renamed' },
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(updateCannedResponseMock).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ response: { id: 'tpl-1', title: 'Renamed' } });
  });

  it('PATCH /sms-inbox/templates/:id accepts a clean body update', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'patch', '/sms-inbox/templates/:id');

    updateCannedResponseMock.mockResolvedValueOnce({ id: 'tpl-1' });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1', role: 'manager' },
      params: { id: 'tpl-1' },
      body: { body: 'Hi {{contact_name}} — {{agent_name}} here.' },
      headers: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(updateCannedResponseMock).toHaveBeenCalledTimes(1);
  });
});
