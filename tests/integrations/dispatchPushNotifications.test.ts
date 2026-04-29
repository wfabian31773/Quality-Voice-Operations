// Tests for the technician push notification fan-out: lifecycle event
// copy/payload, device dedupe + retirement, and Expo POST behavior.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
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

beforeEach(() => {
  queryMock.mockReset();
});

describe('fireDispatchPush copy + payload', () => {
  it('produces a "Job cancelled" push with deep-link jobId for the assigned tech', async () => {
    vi.resetModules();
    const sendMock = vi.fn(async () => ({ attempted: 1, accepted: 1, retired: 0 }));
    vi.doMock('../../platform/notifications/PushDispatcher', () => ({
      sendDispatchPush: sendMock,
    }));
    const { fireDispatchPush } = await import('../../platform/notifications/dispatchPush');

    await fireDispatchPush({
      event: 'job_cancelled',
      tenantId: 'tenant-A',
      resourceIds: ['res-1'],
      job: {
        id: 'job-99',
        title: 'Replace water heater',
        status: 'cancelled',
        contact_name: 'Jane Doe',
        address: '123 Main St',
      },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [target, payload] = sendMock.mock.calls[0];
    expect(target).toEqual({
      tenantId: 'tenant-A',
      resourceIds: ['res-1'],
      userIds: undefined,
      // The dispatcher tags the persisted telemetry row with the lifecycle
      // event name so the Platform Admin "push delivery health" panel can
      // break failures down by event type.
      event: 'job_cancelled',
    });
    expect(payload.title).toBe('Job cancelled');
    expect(payload.body).toContain('Replace water heater');
    expect(payload.body).toContain('Jane Doe');
    expect(payload.body).toContain('123 Main St');
    expect(payload.data).toMatchObject({
      event: 'job_cancelled',
      tenantId: 'tenant-A',
      jobId: 'job-99',
      jobStatus: 'cancelled',
    });
    expect(payload.channelId).toBe('dispatch');
    expect(payload.priority).toBe('high');

    vi.doUnmock('../../platform/notifications/PushDispatcher');
  });

  it('produces an "Appointment cancelled" push with the bookingId for deep-linking', async () => {
    vi.resetModules();
    const sendMock = vi.fn(async () => ({ attempted: 1, accepted: 1, retired: 0 }));
    vi.doMock('../../platform/notifications/PushDispatcher', () => ({
      sendDispatchPush: sendMock,
    }));
    const { fireDispatchPush } = await import('../../platform/notifications/dispatchPush');

    await fireDispatchPush({
      event: 'booking_cancelled',
      tenantId: 'tenant-A',
      resourceIds: ['res-1'],
      booking: {
        id: 'bk-7',
        title: 'Annual checkup',
        start_time: '2026-05-01T15:00:00.000Z',
      },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [, payload] = sendMock.mock.calls[0];
    expect(payload.title).toBe('Appointment cancelled');
    expect(payload.body).toContain('Annual checkup');
    expect(payload.data).toMatchObject({
      event: 'booking_cancelled',
      tenantId: 'tenant-A',
      bookingId: 'bk-7',
    });

    vi.doUnmock('../../platform/notifications/PushDispatcher');
  });
});

describe('PushDispatcher.sendDispatchPush', () => {
  it('skips delivery and short-circuits when no devices match the target', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const fetchMock = vi.fn();
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['res-1'] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    expect(result.attempted).toBe(0);
    expect(result.accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dedupes the same push_token registered against both a user and a resource', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'dev-1', push_token: 'ExponentPushToken[same]' },
        { id: 'dev-2', push_token: 'ExponentPushToken[same]' }, // duplicate token
        { id: 'dev-3', push_token: 'ExponentPushToken[other]' },
      ],
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ status: 'ok' }, { status: 'ok' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'], userIds: ['u1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(result.attempted).toBe(2);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toHaveLength(2);
    const tokens = body.map((m: { to: string }) => m.to);
    expect(new Set(tokens).size).toBe(2);
  });

  it('retires tokens that Expo reports as DeviceNotRegistered', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'dev-1', push_token: 'ExponentPushToken[dead]' }],
      })
      // The retire UPDATE statement
      .mockResolvedValueOnce({ rows: [] });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              status: 'error',
              message: 'gone',
              details: { error: 'DeviceNotRegistered' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.retired).toBe(1);
    const updateCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE user_devices'),
    );
    expect(updateCall).toBeTruthy();
    expect(String(updateCall![0])).toMatch(/push_enabled = FALSE/);
  });

  it('swallows network errors so the dispatch state machine is never blocked', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'dev-1', push_token: 'ExponentPushToken[abc]' }],
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.retired).toBe(0);
  });
});

describe('PushDispatcher.sendDispatchPush — device-token resolution', () => {
  it('short-circuits with no SQL when tenantId is missing', async () => {
    const fetchMock = vi.fn();
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    const result = await sendDispatchPush(
      // empty tenantId — multi-tenant safety: never broadcast across tenants
      { tenantId: '', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({ attempted: 0, accepted: 0, retired: 0, dropped: 0, failureReason: null });
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('short-circuits with no SQL when neither resourceIds nor userIds are supplied', async () => {
    const fetchMock = vi.fn();
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: [], userIds: [] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({ attempted: 0, accepted: 0, retired: 0, dropped: 0, failureReason: null });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('strips falsy ids before issuing the SELECT (no all-null OR clauses)', async () => {
    const fetchMock = vi.fn();
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    const result = await sendDispatchPush(
      // both arrays contain only falsy ids → after filtering, nothing to look up
      { tenantId: 'tenant-A', resourceIds: ['', undefined as unknown as string], userIds: [''] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({ attempted: 0, accepted: 0, retired: 0, dropped: 0, failureReason: null });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('queries user_devices with tenant_id, push_enabled = TRUE, platform = expo, and the resource ids', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const fetchMock = vi.fn();
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1', 'r2'] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, values] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/FROM\s+user_devices/i);
    expect(String(sql)).toMatch(/tenant_id\s*=\s*\$1/);
    expect(String(sql)).toMatch(/push_enabled\s*=\s*TRUE/);
    expect(String(sql)).toMatch(/platform\s*=\s*'expo'/);
    expect(String(sql)).toMatch(/resource_id\s*=\s*ANY\(\$2::varchar\[\]\)/);
    // The OR clause should not contain a user_id branch when no userIds provided
    expect(String(sql)).not.toMatch(/user_id\s*=\s*ANY/);
    expect(values).toEqual(['tenant-A', ['r1', 'r2']]);
  });

  it('combines resourceIds and userIds with an OR and binds both parameter slots', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const fetchMock = vi.fn();
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'], userIds: ['u1', 'u2'] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    const [sql, values] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(
      /resource_id\s*=\s*ANY\(\$2::varchar\[\]\)\s*OR\s*user_id\s*=\s*ANY\(\$3::varchar\[\]\)/,
    );
    expect(values).toEqual(['tenant-A', ['r1'], ['u1', 'u2']]);
  });

  it('uses only the user_id branch (binding $2) when only userIds are provided', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const fetchMock = vi.fn();
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    await sendDispatchPush(
      { tenantId: 'tenant-A', userIds: ['u1'] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    const [sql, values] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/user_id\s*=\s*ANY\(\$2::varchar\[\]\)/);
    expect(String(sql)).not.toMatch(/resource_id\s*=\s*ANY/);
    expect(values).toEqual(['tenant-A', ['u1']]);
  });

  it('returns an empty result (no fetch) when the device lookup query throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('db unreachable'));
    const fetchMock = vi.fn();
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toEqual({ attempted: 0, accepted: 0, retired: 0, dropped: 0, failureReason: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PushDispatcher.sendDispatchPush — Expo payload formatting', () => {
  it('POSTs the Expo-shaped payload (to/title/body/sound/data/channelId/priority) with JSON headers', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'dev-1', push_token: 'ExponentPushToken[abc]' }],
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      {
        title: 'New job',
        body: 'You have been assigned',
        data: { jobId: 'job-7', deepLink: 'app://jobs/job-7' },
        channelId: 'dispatch',
        priority: 'high',
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['Accept-Encoding']).toBe('gzip, deflate');

    const body = JSON.parse(String(init?.body));
    expect(body).toEqual([
      {
        to: 'ExponentPushToken[abc]',
        title: 'New job',
        body: 'You have been assigned',
        sound: 'default',
        data: { jobId: 'job-7', deepLink: 'app://jobs/job-7' },
        channelId: 'dispatch',
        priority: 'high',
      },
    ]);
  });

  it("defaults sound to 'default' and priority to 'high' when not provided, and sends data: {}", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'dev-1', push_token: 'ExponentPushToken[abc]' }],
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body[0].sound).toBe('default');
    expect(body[0].priority).toBe('high');
    expect(body[0].data).toEqual({});
  });

  it('honors sound: null to deliver a silent push (no system sound on iOS)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'dev-1', push_token: 'ExponentPushToken[abc]' }],
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');

    await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b', sound: null },
      fetchMock,
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body[0].sound).toBeNull();
  });
});

describe('PushDispatcher.sendDispatchPush — batching', () => {
  it('splits >100 devices into multiple Expo POSTs of at most EXPO_BATCH_SIZE (100) each', async () => {
    // 230 devices → 100 + 100 + 30 across three POSTs
    const tokens = Array.from({ length: 230 }, (_, i) => ({
      id: `dev-${i}`,
      push_token: `ExponentPushToken[${i}]`,
    }));
    queryMock.mockResolvedValueOnce({ rows: tokens });

    const okBody = (n: number) =>
      JSON.stringify({ data: Array.from({ length: n }, () => ({ status: 'ok' })) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(okBody(100), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(okBody(100), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(okBody(30), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sliceLengths = fetchMock.mock.calls.map(
      (c) => JSON.parse(String(c[1]?.body)).length as number,
    );
    expect(sliceLengths).toEqual([100, 100, 30]);
    expect(result.attempted).toBe(230);
    expect(result.accepted).toBe(230);
    expect(result.retired).toBe(0);
  });

  it('continues to subsequent batches when an earlier batch fails (partial delivery)', async () => {
    const tokens = Array.from({ length: 150 }, (_, i) => ({
      id: `dev-${i}`,
      push_token: `ExponentPushToken[${i}]`,
    }));
    queryMock.mockResolvedValueOnce({ rows: tokens });

    const fetchMock = vi
      .fn()
      // First batch: HTTP 500 — one bad batch must not poison the rest
      .mockResolvedValueOnce(
        new Response('boom', { status: 500 }),
      )
      // Second batch: succeeds with 50 ok tickets
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: Array.from({ length: 50 }, () => ({ status: 'ok' })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempted).toBe(150);
    expect(result.accepted).toBe(50); // only the second batch tickets counted
    expect(result.retired).toBe(0);
  });
});

describe('PushDispatcher.sendDispatchPush — Expo error handling', () => {
  it('treats an HTTP 429 (rate limit) as a soft failure and does not throw', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'dev-1', push_token: 'ExponentPushToken[abc]' }],
    });
    const fetchMock = vi.fn(async () =>
      new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '5' },
      }),
    );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.retired).toBe(0);
  });

  it('handles a non-JSON 200 response gracefully (no accepted, no throw)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'dev-1', push_token: 'ExponentPushToken[abc]' }],
    });
    const fetchMock = vi.fn(async () =>
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.retired).toBe(0);
  });

  it('also retires tokens flagged as InvalidCredentials (not just DeviceNotRegistered)', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'dev-bad', push_token: 'ExponentPushToken[bad-creds]' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              status: 'error',
              message: 'bad credentials',
              details: { error: 'InvalidCredentials' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(result.retired).toBe(1);
    const updateCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE user_devices'),
    );
    expect(updateCall).toBeTruthy();
    expect(String(updateCall![0])).toMatch(/push_enabled = FALSE/);
    expect(updateCall![1]).toEqual(['dev-bad']);
  });

  it('does NOT retire tokens for transient ticket errors (e.g. MessageRateExceeded)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'dev-1', push_token: 'ExponentPushToken[a]' },
        { id: 'dev-2', push_token: 'ExponentPushToken[b]' },
      ],
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { status: 'ok', id: 'ticket-1' },
            {
              status: 'error',
              message: 'too many',
              details: { error: 'MessageRateExceeded' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(result.attempted).toBe(2);
    expect(result.accepted).toBe(1);
    expect(result.retired).toBe(0);
    const updateCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE user_devices'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('does not crash when the retire UPDATE itself throws (logs and moves on)', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'dev-1', push_token: 'ExponentPushToken[dead]' }],
      })
      .mockRejectedValueOnce(new Error('write failure'));
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              status: 'error',
              message: 'gone',
              details: { error: 'DeviceNotRegistered' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    // Retire failed silently — the result reflects the attempted retire (0)
    // and the dispatch still completed without throwing.
    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.retired).toBe(0);
  });

  it('tolerates a payload with fewer tickets than messages without misindexing devices', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'dev-1', push_token: 'ExponentPushToken[a]' },
        { id: 'dev-2', push_token: 'ExponentPushToken[b]' },
      ],
    });
    // Expo returned only one ticket for two messages — should not crash and
    // should only count what was acknowledged.
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { sendDispatchPush } = await import('../../platform/notifications/PushDispatcher');
    const result = await sendDispatchPush(
      { tenantId: 'tenant-A', resourceIds: ['r1'] },
      { title: 't', body: 'b' },
      fetchMock,
    );

    expect(result.attempted).toBe(2);
    expect(result.accepted).toBe(1);
    expect(result.retired).toBe(0);
  });
});
