// Verifies the shared dispatch merge-token allowlist (task #793):
//   - findUnknownDispatchMergeTokens flags typos like {{tracking_link}}
//     while letting through every renderer-supported token (with or
//     without inner whitespace), so the editor can warn dispatchers
//     before a broken merge field reaches a customer.
//   - createNotificationTemplateHandler / updateNotificationTemplateHandler
//     reject saves that contain unknown tokens in either the body or
//     the subject, so the editor warning can't be bypassed by a direct
//     API call.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import {
  DISPATCH_MERGE_TOKENS,
  DISPATCH_MERGE_TOKEN_SAMPLES,
  findUnknownDispatchMergeTokens,
  renderDispatchTemplate,
} from '../../shared/dispatch/mergeTokens';

describe('findUnknownDispatchMergeTokens', () => {
  it('returns an empty array when every token is in the allowlist', () => {
    const body = 'Hi {{contact_name}}, your tech {{resource_name}} is ~{{eta_drive_minutes}} min away. Track: {{tracking_url}}';
    expect(findUnknownDispatchMergeTokens(body)).toEqual([]);
  });

  it('tolerates inner whitespace in the merge token braces', () => {
    expect(findUnknownDispatchMergeTokens('Hi {{ contact_name }}!')).toEqual([]);
  });

  it('flags typos and dedupes repeated unknown tokens in source order', () => {
    const body = 'Track: {{tracking_link}} ({{tracking_link}}, {{eta_window}})';
    expect(findUnknownDispatchMergeTokens(body)).toEqual(['tracking_link', 'eta_window']);
  });

  it('flags malformed token shapes the renderer cannot substitute', () => {
    // Hyphens, dots, spaces, and other punctuation produce names the
    // renderer's substitute() will not match, so they would silently
    // leak the raw braces to the customer if we let them through.
    const body =
      'Hi {{tracking-url}} | {{tracking.url}} | {{ tracking link }} | {{}} | {{contact_name}}';
    expect(findUnknownDispatchMergeTokens(body)).toEqual([
      'tracking-url',
      'tracking.url',
      'tracking link',
    ]);
  });

  it('returns [] for non-string or empty inputs so callers can pass raw form state', () => {
    expect(findUnknownDispatchMergeTokens(undefined)).toEqual([]);
    expect(findUnknownDispatchMergeTokens(null)).toEqual([]);
    expect(findUnknownDispatchMergeTokens('')).toEqual([]);
    expect(findUnknownDispatchMergeTokens(42)).toEqual([]);
  });

  it('provides an obvious-fake sample value for every supported token', () => {
    // The editor's live preview (task #807) uses these to render the
    // template against a sample job. Adding a token without a sample
    // would be a TS compile error — this guard catches the case where
    // the typed Record itself is widened by accident.
    for (const token of DISPATCH_MERGE_TOKENS) {
      expect(DISPATCH_MERGE_TOKEN_SAMPLES[token]).toBeTypeOf('string');
      expect(DISPATCH_MERGE_TOKEN_SAMPLES[token].length).toBeGreaterThan(0);
    }
  });

  it('exports the full list of renderer-supported tokens', () => {
    // If this changes, fireNotifications() in
    // server/admin-api/routes/dispatch.ts must add a value for the
    // new token in its tokenValues map (TS will fail the build
    // otherwise — that's the point of the typed Record).
    expect(DISPATCH_MERGE_TOKENS).toEqual([
      'job_title',
      'contact_name',
      'eta',
      'eta_drive_minutes',
      'eta_arrival_time',
      'resource_name',
      'status',
      'address',
      'tracking_url',
    ]);
  });
});

describe('renderDispatchTemplate', () => {
  it('substitutes every known token using the supplied value map', () => {
    const out = renderDispatchTemplate(
      'Hi {{contact_name}}, your tech {{resource_name}} arrives by {{eta_arrival_time}}. Track: {{tracking_url}}',
    );
    expect(out).toBe(
      `Hi ${DISPATCH_MERGE_TOKEN_SAMPLES.contact_name}, your tech ${DISPATCH_MERGE_TOKEN_SAMPLES.resource_name} arrives by ${DISPATCH_MERGE_TOKEN_SAMPLES.eta_arrival_time}. Track: ${DISPATCH_MERGE_TOKEN_SAMPLES.tracking_url}`,
    );
  });

  it('tolerates inner whitespace just like the server renderer', () => {
    expect(renderDispatchTemplate('Hi {{ contact_name }}!')).toBe(
      `Hi ${DISPATCH_MERGE_TOKEN_SAMPLES.contact_name}!`,
    );
  });

  it('leaves unknown tokens untouched so the preview matches what customers would see', () => {
    expect(renderDispatchTemplate('Hi {{contact_name}}, see {{tracking_link}}')).toBe(
      `Hi ${DISPATCH_MERGE_TOKEN_SAMPLES.contact_name}, see {{tracking_link}}`,
    );
  });

  it('returns an empty string for empty / non-string inputs so callers can pass raw form state', () => {
    expect(renderDispatchTemplate('')).toBe('');
    // Defensive: form state can briefly be undefined while a field
    // mounts; the editor passes the raw value through without a guard.
    expect(renderDispatchTemplate(undefined as unknown as string)).toBe('');
  });

  it('accepts a custom value map for callers that want non-sample data', () => {
    const out = renderDispatchTemplate('Hi {{contact_name}}', {
      ...DISPATCH_MERGE_TOKEN_SAMPLES,
      contact_name: 'Tester',
    });
    expect(out).toBe('Hi Tester');
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
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: Request, _res: Response, next: () => void) => next(),
  requireRole: () => (_req: Request, _res: Response, next: () => void) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../server/replit_integrations/object_storage', () => ({
  ObjectStorageService: class {},
  ObjectNotFoundError: class extends Error {},
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
  const mod = await import('../../server/admin-api/routes/dispatch');
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

describe('notification template handlers reject unknown merge tokens', () => {
  it('POST /dispatch/notification-templates returns 400 for an unknown body token', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/dispatch/notification-templates');

    const req = {
      user: { tenantId: 'tenant-A' },
      body: {
        name: 'En route SMS',
        trigger_event: 'en_route',
        channel: 'sms',
        subject: '',
        body_template: 'Track your tech: {{tracking_link}}',
        is_active: true,
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queryMock).not.toHaveBeenCalled();
    const payload = (res.json.mock.calls[0][0] as {
      error: string;
      unknownTokens: string[];
      knownTokens: readonly string[];
    });
    expect(payload.unknownTokens).toEqual(['tracking_link']);
    expect(payload.knownTokens).toEqual(DISPATCH_MERGE_TOKENS);
    expect(payload.error).toContain('{{tracking_link}}');
    // The error must list the supported tokens so a dispatcher hitting
    // this via curl/Postman gets the same guidance the editor shows.
    expect(payload.error).toContain('{{tracking_url}}');
  });

  it('POST /dispatch/notification-templates also rejects unknown tokens in the subject', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/dispatch/notification-templates');

    const req = {
      user: { tenantId: 'tenant-A' },
      body: {
        name: 'En route SMS',
        trigger_event: 'en_route',
        channel: 'sms',
        subject: 'Hi {{customer_name}}',
        body_template: 'On the way',
        is_active: true,
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queryMock).not.toHaveBeenCalled();
    const payload = (res.json.mock.calls[0][0] as { unknownTokens: string[] });
    expect(payload.unknownTokens).toEqual(['customer_name']);
  });

  it('POST /dispatch/notification-templates inserts when every token is in the allowlist', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/dispatch/notification-templates');

    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] });

    const req = {
      user: { tenantId: 'tenant-A' },
      body: {
        name: 'En route SMS',
        trigger_event: 'en_route',
        channel: 'sms',
        subject: 'Heads up {{contact_name}}',
        body_template: 'Track: {{tracking_url}}',
        is_active: true,
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('PUT /dispatch/notification-templates/:id returns 400 for an unknown body token', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/dispatch/notification-templates/:id');

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'tpl-1' },
      body: { body_template: 'See {{tracking_link}}' },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queryMock).not.toHaveBeenCalled();
    const payload = (res.json.mock.calls[0][0] as { unknownTokens: string[] });
    expect(payload.unknownTokens).toEqual(['tracking_link']);
  });

  it('PUT /dispatch/notification-templates/:id skips token validation when subject and body are absent', async () => {
    // Partial updates that only toggle is_active or rename the
    // template must still succeed — we only validate fields that are
    // actually present in the patch body.
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/dispatch/notification-templates/:id');

    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] });

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'tpl-1' },
      body: { is_active: false },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ template: { id: 'tpl-1' } });
  });
});
