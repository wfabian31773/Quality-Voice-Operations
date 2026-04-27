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
    expect(target).toEqual({ tenantId: 'tenant-A', resourceIds: ['res-1'], userIds: undefined });
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
