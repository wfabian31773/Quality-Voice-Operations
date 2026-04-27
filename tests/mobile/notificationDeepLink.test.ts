import { describe, expect, it, vi } from 'vitest';
import {
  notificationTargetPath,
  processColdStartResponse,
} from '../../shared/notifications/deepLink';

describe('notificationTargetPath', () => {
  it('routes job pushes to /jobs/:id', () => {
    expect(notificationTargetPath({ jobId: 'job-1' })).toBe('/jobs/job-1');
    expect(
      notificationTargetPath({ event: 'job_assigned', jobId: 'abc', jobStatus: 'assigned' }),
    ).toBe('/jobs/abc');
  });

  it('routes booking pushes to /bookings/:id', () => {
    expect(notificationTargetPath({ bookingId: 'bk-7' })).toBe('/bookings/bk-7');
    expect(
      notificationTargetPath({ event: 'booking_cancelled', bookingId: 'bk-9' }),
    ).toBe('/bookings/bk-9');
  });

  it('prefers jobId when both ids are present', () => {
    expect(notificationTargetPath({ jobId: 'j', bookingId: 'b' })).toBe('/jobs/j');
  });

  it('returns null for empty / non-routable payloads', () => {
    expect(notificationTargetPath(null)).toBeNull();
    expect(notificationTargetPath(undefined)).toBeNull();
    expect(notificationTargetPath({})).toBeNull();
    expect(notificationTargetPath({ jobId: 123 as unknown as string })).toBeNull();
  });
});

function makeResp(id: string, data: Record<string, unknown>) {
  return {
    notification: {
      request: {
        identifier: id,
        content: { data },
      },
    },
  };
}

describe('processColdStartResponse (cold-start dedupe)', () => {
  it('routes the launching notification on the first cold start', async () => {
    const reads = vi.fn(async () => null);
    const writes = vi.fn(async () => {});
    const result = await processColdStartResponse(
      makeResp('push-1', { jobId: 'job-1' }),
      { readLastHandledPushId: reads, writeLastHandledPushId: writes },
    );
    expect(result).toEqual({ skipped: null, path: '/jobs/job-1' });
    expect(writes).toHaveBeenCalledWith('push-1');
  });

  it('skips an already-handled notification on a subsequent cold start', async () => {
    const reads = vi.fn(async () => 'push-1');
    const writes = vi.fn(async () => {});
    const result = await processColdStartResponse(
      makeResp('push-1', { jobId: 'job-1' }),
      { readLastHandledPushId: reads, writeLastHandledPushId: writes },
    );
    expect(result).toEqual({ skipped: 'duplicate', path: null });
    expect(writes).not.toHaveBeenCalled();
  });

  it('routes a different launching notification even when one was previously handled', async () => {
    const reads = vi.fn(async () => 'push-1');
    const writes = vi.fn(async () => {});
    const result = await processColdStartResponse(
      makeResp('push-2', { bookingId: 'bk-9' }),
      { readLastHandledPushId: reads, writeLastHandledPushId: writes },
    );
    expect(result).toEqual({ skipped: null, path: '/bookings/bk-9' });
    expect(writes).toHaveBeenCalledWith('push-2');
  });

  it('returns no-response when expo did not surface a launching notification', async () => {
    const result = await processColdStartResponse(null, {
      readLastHandledPushId: vi.fn(async () => null),
      writeLastHandledPushId: vi.fn(async () => {}),
    });
    expect(result).toEqual({ skipped: 'no-response', path: null });
  });

  it('returns no-id when the response is missing an identifier', async () => {
    const writes = vi.fn(async () => {});
    const result = await processColdStartResponse(
      { notification: { request: { content: { data: { jobId: 'x' } } } } },
      { readLastHandledPushId: vi.fn(async () => null), writeLastHandledPushId: writes },
    );
    expect(result).toEqual({ skipped: 'no-id', path: null });
    expect(writes).not.toHaveBeenCalled();
  });
});
