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
  countSmsSegments,
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

// Carriers split SMS bodies into multiple billed segments past 160
// GSM-7 chars (or 70 UCS-2 chars). The dispatch template editor's
// preview surfaces the live count so a dispatcher can spot a 161-char
// message before it costs them double on the next Twilio bill.
describe('countSmsSegments', () => {
  it('returns zero segments for empty / non-string inputs (raw form state)', () => {
    expect(countSmsSegments('')).toEqual({
      encoding: 'GSM-7',
      characters: 0,
      charactersPerSegment: 160,
      segments: 0,
      remaining: 160,
    });
    expect(countSmsSegments(undefined)).toMatchObject({ segments: 0, characters: 0 });
    expect(countSmsSegments(null)).toMatchObject({ segments: 0, characters: 0 });
    expect(countSmsSegments(42)).toMatchObject({ segments: 0, characters: 0 });
  });

  it('counts a short GSM-7 body as a single 160-char segment', () => {
    const info = countSmsSegments('Hello dispatcher!');
    expect(info.encoding).toBe('GSM-7');
    expect(info.characters).toBe(17);
    expect(info.segments).toBe(1);
    expect(info.charactersPerSegment).toBe(160);
    expect(info.remaining).toBe(160 - 17);
  });

  it('treats exactly 160 GSM-7 characters as one segment, 161 as two', () => {
    const oneSeg = 'a'.repeat(160);
    const twoSeg = 'a'.repeat(161);
    expect(countSmsSegments(oneSeg)).toMatchObject({
      segments: 1,
      characters: 160,
      charactersPerSegment: 160,
      remaining: 0,
    });
    // Once concatenated, each segment carries a UDH and only fits 153.
    expect(countSmsSegments(twoSeg)).toMatchObject({
      segments: 2,
      characters: 161,
      charactersPerSegment: 153,
      remaining: 153 * 2 - 161,
    });
  });

  it('counts GSM-7 extension-table characters as 2 (matches carrier billing)', () => {
    // `{`, `}`, `[`, `]`, `\`, `^`, `~`, `|`, `€`, form-feed each
    // travel as ESC + char on the wire. A 159-char message that ends
    // in `€` therefore tips into a second segment — exactly the
    // surprise the editor needs to flag.
    expect(countSmsSegments('€').characters).toBe(2);
    expect(countSmsSegments('{}[]').characters).toBe(8);
    const dangerous = 'a'.repeat(159) + '€';
    expect(countSmsSegments(dangerous)).toMatchObject({
      encoding: 'GSM-7',
      characters: 161,
      segments: 2,
    });
  });

  it('switches to UCS-2 (70-char single segment) on the first non-GSM character', () => {
    // An em-dash isn't in the GSM-7 table — pasting one into an
    // otherwise plain-ASCII template silently halves the per-segment
    // budget. The preview must catch that.
    const info = countSmsSegments('Hello — dispatcher');
    expect(info.encoding).toBe('UCS-2');
    expect(info.characters).toBe('Hello — dispatcher'.length);
    expect(info.charactersPerSegment).toBe(70);
    expect(info.segments).toBe(1);
  });

  it('counts UCS-2 boundary at 70 chars (one segment) and 71 chars (two)', () => {
    // Use a non-GSM character (Cyrillic 'я') to force UCS-2 mode.
    const oneSeg = 'я'.repeat(70);
    const twoSeg = 'я'.repeat(71);
    expect(countSmsSegments(oneSeg)).toMatchObject({
      encoding: 'UCS-2',
      characters: 70,
      charactersPerSegment: 70,
      segments: 1,
      remaining: 0,
    });
    expect(countSmsSegments(twoSeg)).toMatchObject({
      encoding: 'UCS-2',
      characters: 71,
      charactersPerSegment: 67,
      segments: 2,
      remaining: 67 * 2 - 71,
    });
  });

  it('counts a non-BMP emoji as 2 UCS-2 code units (matches carrier metering)', () => {
    // 😀 is a surrogate pair in UTF-16 — carriers bill it as 2 chars.
    // We must not double-count it as two separate non-GSM characters.
    const info = countSmsSegments('Hi 😀');
    expect(info.encoding).toBe('UCS-2');
    // 'Hi ' (3) + 😀 (2 UTF-16 code units) = 5
    expect(info.characters).toBe(5);
    expect(info.segments).toBe(1);
  });

  it('reports the segment count for a fully-rendered dispatch template', () => {
    // Glue countSmsSegments to renderDispatchTemplate the same way
    // the preview panel does, so a refactor that breaks the wiring
    // (e.g. counting the raw template instead of the rendered body)
    // gets caught here.
    const rendered = renderDispatchTemplate(
      'Hi {{contact_name}}, your tech {{resource_name}} arrives by {{eta_arrival_time}}. Track: {{tracking_url}}',
    );
    const info = countSmsSegments(rendered);
    expect(info.encoding).toBe('GSM-7');
    expect(info.characters).toBe(rendered.length);
    expect(info.segments).toBeGreaterThanOrEqual(1);
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

    // 1) tenant SMS segment-limit lookup (null = unlimited);
    // 2) the actual INSERT.
    queryMock.mockResolvedValueOnce({ rows: [{ n: null }] });
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
    expect(queryMock).toHaveBeenCalledTimes(2);
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

    // 1) tenant SMS segment-limit lookup (null = unlimited, so the
    //    cap check is skipped entirely);
    // 2) the actual UPDATE.
    queryMock.mockResolvedValueOnce({ rows: [{ n: null }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] });

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'tpl-1' },
      body: { is_active: false },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith({ template: { id: 'tpl-1' } });
  });
});

// Task #844: when the tenant has opted into a per-tenant SMS segment
// cap (`tenants.dispatch_sms_segment_limit`), the notification template
// API must hard-block save attempts whose rendered preview would exceed
// the cap. Mirrors the editor's disable-Save behavior so dispatchers
// can't bypass the warning by curl-ing the API.
describe('notification template handlers enforce the SMS segment cap', () => {
  // 161 GSM-7 chars renders to 2 segments, which a cap of 1 should
  // reject. The body uses `{{contact_name}}` so we also exercise the
  // shared renderer path (sample value 'Jane Doe' lengthens it
  // further, just like it would in production).
  const BODY_OVER_CAP = 'a'.repeat(161);
  // 159-char body is comfortably under one GSM-7 segment.
  const BODY_UNDER_CAP = 'b'.repeat(159);

  it('POST returns 400 with the segment count when the rendered body exceeds the cap', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/dispatch/notification-templates');

    // tenant cap = 1
    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] });

    const req = {
      user: { tenantId: 'tenant-A' },
      body: {
        name: 'Long SMS',
        trigger_event: 'en_route',
        channel: 'sms',
        subject: '',
        body_template: BODY_OVER_CAP,
        is_active: true,
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    // No INSERT must run for a rejected save.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0] as {
      error: string;
      segments: number;
      limit: number;
      characters: number;
    };
    expect(payload.segments).toBe(2);
    expect(payload.limit).toBe(1);
    expect(payload.characters).toBe(161);
    expect(payload.error).toMatch(/2 segments/);
    expect(payload.error).toMatch(/caps dispatch SMS templates at 1/);
  });

  it('POST inserts when the rendered body is at or below the tenant cap', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/dispatch/notification-templates');

    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] }); // tenant cap = 1
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-9' }] }); // INSERT

    const req = {
      user: { tenantId: 'tenant-A' },
      body: {
        name: 'Short SMS',
        trigger_event: 'en_route',
        channel: 'sms',
        subject: '',
        body_template: BODY_UNDER_CAP,
        is_active: true,
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('POST skips the cap check entirely for email-only templates', async () => {
    // The cap is about SMS billing — pasting a 200-char welcome
    // email shouldn't be blocked because the channel doesn't even
    // ship over carriers.
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/dispatch/notification-templates');

    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-2' }] });

    const req = {
      user: { tenantId: 'tenant-A' },
      body: {
        name: 'Long email',
        trigger_event: 'en_route',
        channel: 'email',
        subject: 'Heads up',
        body_template: BODY_OVER_CAP,
        is_active: true,
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('POST allows over-cap SMS bodies when the tenant has not opted in (unlimited)', async () => {
    // Default behavior — `dispatch_sms_segment_limit` is NULL so an
    // existing 200-char template keeps working unchanged.
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/dispatch/notification-templates');

    queryMock.mockResolvedValueOnce({ rows: [{ n: null }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-3' }] });

    const req = {
      user: { tenantId: 'tenant-A' },
      body: {
        name: 'Long SMS',
        trigger_event: 'en_route',
        channel: 'sms',
        subject: '',
        body_template: BODY_OVER_CAP,
        is_active: true,
      },
      params: {},
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('PUT returns 400 when a body-only patch would exceed the cap (looks up existing channel)', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/dispatch/notification-templates/:id');

    // 1) tenant cap lookup; 2) existing-row lookup for channel/body
    //    fallback (the patch only sets body_template).
    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] });
    queryMock.mockResolvedValueOnce({
      rows: [{ channel: 'sms', body_template: 'irrelevant' }],
    });

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'tpl-1' },
      body: { body_template: BODY_OVER_CAP },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0] as {
      segments: number;
      limit: number;
    };
    expect(payload.segments).toBe(2);
    expect(payload.limit).toBe(1);
  });

  it('PUT skips the cap check when the existing row is email-only and channel is not patched', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/dispatch/notification-templates/:id');

    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] }); // tenant cap = 1
    queryMock.mockResolvedValueOnce({
      rows: [{ channel: 'email', body_template: 'old' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] }); // UPDATE

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'tpl-1' },
      body: { body_template: BODY_OVER_CAP },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ template: { id: 'tpl-1' } });
  });

  it('PUT skips the cap check entirely when the tenant has not opted in', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/dispatch/notification-templates/:id');

    // Cap is NULL — we should NOT issue the existing-row lookup,
    // jumping straight to the UPDATE.
    queryMock.mockResolvedValueOnce({ rows: [{ n: null }] });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] });

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'tpl-1' },
      body: { body_template: BODY_OVER_CAP, channel: 'sms' },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('PUT 404s when the existing-row lookup finds no template for this tenant', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/dispatch/notification-templates/:id');

    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'missing' },
      body: { body_template: BODY_OVER_CAP },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('PUT rejects metadata-only patches (e.g. rename) on an already-over-cap template', async () => {
    // Closes the bypass where a dispatcher edits only `name` or
    // `is_active` to "save" an existing oversize template after the
    // tenant flipped on the cap. The handler must always validate
    // the effective post-update row when the cap is set, even if
    // body/channel are absent from the patch.
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/dispatch/notification-templates/:id');

    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] }); // tenant cap = 1
    queryMock.mockResolvedValueOnce({
      rows: [{ channel: 'sms', body_template: BODY_OVER_CAP }],
    });

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'tpl-1' },
      body: { name: 'Renamed but still oversized' },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    // Crucially: no UPDATE fired, so the row stays unchanged in the
    // DB and the dispatcher is forced to trim before the rename
    // sticks.
    expect(queryMock).toHaveBeenCalledTimes(2);
    const payload = res.json.mock.calls[0][0] as {
      segments: number;
      limit: number;
    };
    expect(payload.segments).toBe(2);
    expect(payload.limit).toBe(1);
  });

  it('PUT allows metadata-only patches on an under-cap SMS template', async () => {
    // The mirror of the bypass test: renaming an in-bounds template
    // must still succeed even though the cap is on.
    const router = await loadRouter();
    const handler = findHandler(router, 'put', '/dispatch/notification-templates/:id');

    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] });
    queryMock.mockResolvedValueOnce({
      rows: [{ channel: 'sms', body_template: BODY_UNDER_CAP }],
    });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'tpl-1' }] });

    const req = {
      user: { tenantId: 'tenant-A' },
      params: { id: 'tpl-1' },
      body: { name: 'Friendly rename' },
    } as unknown as Request;
    const res = buildRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ template: { id: 'tpl-1' } });
  });
});
