// Verifies the shared ticket template merge-token allowlist (task #806):
//   - findUnknownTicketTemplateTokens flags typos like {{custmer_name}}
//     while letting through every renderer-supported token (with or
//     without inner whitespace), so the editor can warn agents
//     before a broken merge field reaches a customer.
//   - createTemplateHandler / updateTemplateHandler reject saves whose
//     body contains unknown tokens, so the editor warning can't be
//     bypassed by a direct API call.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import {
  TICKET_TEMPLATE_TOKENS,
  findUnknownTicketTemplateTokens,
  isKnownTicketTemplateToken,
} from '../../shared/tickets/templateTokens';

describe('findUnknownTicketTemplateTokens', () => {
  it('returns an empty array when every token is in the allowlist', () => {
    const body =
      'Ticket {{ticket_number}} ({{subject}}) for {{contact_name}} is now {{status}} priority {{priority}}.';
    expect(findUnknownTicketTemplateTokens(body)).toEqual([]);
  });

  it('tolerates inner whitespace in the merge token braces', () => {
    expect(findUnknownTicketTemplateTokens('Hi {{ contact_name }}!')).toEqual([]);
  });

  it('flags typos and dedupes repeated unknown tokens in source order', () => {
    const body = 'Hi {{custmer_name}}, ticket {{tickt_number}} ({{custmer_name}})';
    expect(findUnknownTicketTemplateTokens(body)).toEqual(['custmer_name', 'tickt_number']);
  });

  it('flags malformed token shapes the renderer cannot substitute', () => {
    // Hyphens, dots, and inner spaces produce names the renderer's
    // substitution regex will not match, so they would silently leak
    // the raw braces to the customer if we let them through.
    const body =
      '{{contact-name}} | {{contact.name}} | {{ contact name }} | {{}} | {{contact_name}}';
    expect(findUnknownTicketTemplateTokens(body)).toEqual([
      'contact-name',
      'contact.name',
      'contact name',
    ]);
  });

  it('returns [] for non-string or empty inputs so callers can pass raw form state', () => {
    expect(findUnknownTicketTemplateTokens(undefined)).toEqual([]);
    expect(findUnknownTicketTemplateTokens(null)).toEqual([]);
    expect(findUnknownTicketTemplateTokens('')).toEqual([]);
    expect(findUnknownTicketTemplateTokens(42)).toEqual([]);
    expect(findUnknownTicketTemplateTokens({})).toEqual([]);
  });

  it('exports the full list of renderer-supported tokens', () => {
    // If this changes, insertTemplate() in
    // client-app/src/pages/TicketDetail.tsx must add a value for the
    // new token in its substitution map.
    expect(TICKET_TEMPLATE_TOKENS).toEqual([
      'ticket_number',
      'subject',
      'status',
      'priority',
      'contact_name',
      'contact_email',
      'contact_phone',
      'department',
      'assignee',
      'created_at',
    ]);
  });
});

describe('isKnownTicketTemplateToken', () => {
  it('recognizes every canonical token', () => {
    for (const token of TICKET_TEMPLATE_TOKENS) {
      expect(isKnownTicketTemplateToken(token)).toBe(true);
    }
  });

  it('rejects unknown tokens', () => {
    expect(isKnownTicketTemplateToken('custmer_name')).toBe(false);
    expect(isKnownTicketTemplateToken('contact-name')).toBe(false);
    // Validation is case-sensitive here because insertTemplate()'s
    // substitution regex is case-sensitive too — flag mixed case so
    // the editor catches it before the customer sees the raw braces.
    expect(isKnownTicketTemplateToken('Contact_Name')).toBe(false);
  });
});

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
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
vi.mock('../../platform/email', () => ({
  sendEmail: vi.fn(),
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
  queryMock.mockReset();
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
  const mod = await import('../../server/admin-api/routes/tickets');
  return mod.default;
}

function findHandler(
  router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> }; handle: unknown }> },
  method: 'post' | 'put',
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

describe('ticket template handlers reject unknown merge tokens', () => {
  it('POST /ticket-templates returns 400 for an unknown body token', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/ticket-templates');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1' },
      body: {
        name: 'Standard reply',
        subject: 'Re: {{ticket_number}}',
        body: 'Hi {{custmer_name}}, your ticket is {{status}}.',
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queryMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as {
      error: string;
      unknownTokens: string[];
      knownTokens: readonly string[];
    };
    expect(payload.unknownTokens).toEqual(['custmer_name']);
    expect(payload.knownTokens).toEqual(TICKET_TEMPLATE_TOKENS);
    expect(payload.error).toContain('{{custmer_name}}');
    // The error must list the supported tokens so an agent hitting
    // this via curl/Postman gets the same guidance the editor shows.
    expect(payload.error).toContain('{{contact_name}}');
  });

  it('POST /ticket-templates flags malformed token shapes', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/ticket-templates');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1' },
      body: {
        name: 'Standard reply',
        subject: '',
        body: 'Hi {{contact-name}} / {{ contact name }}',
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queryMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { unknownTokens: string[] };
    expect(payload.unknownTokens).toEqual(['contact-name', 'contact name']);
  });

  it('POST /ticket-templates inserts when every token is in the allowlist', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/ticket-templates');

    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1' },
      body: {
        name: 'Standard reply',
        subject: 'Re: {{ticket_number}}',
        body: 'Hi {{contact_name}}, ticket {{ticket_number}} is now {{status}}.',
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('POST /ticket-templates still requires name and body before token validation', async () => {
    // Sanity check that the existing 400 for missing fields still fires
    // even when token validation would otherwise pass. (Token validation
    // runs against `body`, so a missing body must be rejected first
    // for the right reason.)
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/ticket-templates');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1' },
      body: { name: 'Standard reply' },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queryMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { error: string };
    expect(payload.error).toMatch(/name and body/);
  });

  it('PUT /ticket-templates/:id returns 400 for an unknown body token', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/ticket-templates/:id');

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1' },
      params: { id: 'tpl-1' },
      body: { body: 'Hello {{custmer_name}}' },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queryMock).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0] as { unknownTokens: string[] };
    expect(payload.unknownTokens).toEqual(['custmer_name']);
  });

  it('PUT /ticket-templates/:id skips token validation when body is absent', async () => {
    // Partial updates that only toggle is_active or rename the
    // template must still succeed — we only validate fields that are
    // actually present in the patch body.
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/ticket-templates/:id');

    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1' },
      params: { id: 'tpl-1' },
      body: { is_active: false },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ template: { id: 'tpl-1' } });
  });

  it('PUT /ticket-templates/:id accepts a clean body update', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/ticket-templates/:id');

    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] });

    const req = {
      user: { tenantId: 'tenant-A', userId: 'user-1' },
      params: { id: 'tpl-1' },
      body: { body: 'Hi {{contact_name}}, ticket {{ticket_number}} is now {{status}}.' },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
