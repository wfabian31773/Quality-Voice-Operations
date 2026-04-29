import { describe, expect, it } from 'vitest';
import {
  deserializeLog,
  eventLabel,
  markAllRead,
  markRead,
  notificationFromExpo,
  notificationTargetPathFromRecord,
  serializeLog,
  shouldResetOnAuthChange,
  unreadCount,
  upsertNotification,
  type NotificationRecord,
} from '../../shared/notifications/inbox';

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: 'push-1',
    receivedAt: 1_700_000_000_000,
    title: 'New job assigned',
    body: 'Fix sink · 123 Main St',
    event: 'job_assigned',
    jobId: 'job-1',
    bookingId: null,
    read: false,
    ...over,
  };
}

describe('notificationFromExpo', () => {
  it('builds a record from a fully populated expo notification', () => {
    const out = notificationFromExpo({
      date: 1_700_000_000_000,
      request: {
        identifier: 'push-1',
        content: {
          title: 'New job assigned',
          body: 'Fix sink',
          data: { event: 'job_assigned', jobId: 'job-1' },
        },
      },
    });
    expect(out).toEqual({
      id: 'push-1',
      receivedAt: 1_700_000_000_000,
      title: 'New job assigned',
      body: 'Fix sink',
      event: 'job_assigned',
      jobId: 'job-1',
      bookingId: null,
      read: false,
    });
  });

  it('extracts bookingId when present', () => {
    const out = notificationFromExpo({
      request: {
        identifier: 'push-2',
        content: {
          title: 'Appointment rescheduled',
          body: 'Tomorrow',
          data: { event: 'booking_rescheduled', bookingId: 'bk-9' },
        },
      },
    });
    expect(out?.bookingId).toBe('bk-9');
    expect(out?.jobId).toBeNull();
  });

  it('falls back to a synthetic id when no identifier is provided', () => {
    const out = notificationFromExpo(
      {
        request: { content: { title: 'Hi', body: 'There' } },
      },
      () => 1_700_000_000_001,
    );
    expect(out?.id.startsWith('local-1700000000001')).toBe(true);
    expect(out?.receivedAt).toBe(1_700_000_000_001);
  });

  it('returns null for empty notifications', () => {
    expect(notificationFromExpo(null)).toBeNull();
    expect(notificationFromExpo(undefined)).toBeNull();
    expect(
      notificationFromExpo({ request: { content: { title: '', body: '' } } }),
    ).toBeNull();
  });
});

describe('upsertNotification', () => {
  it('prepends new entries newest-first', () => {
    const a = rec({ id: 'a', receivedAt: 1 });
    const b = rec({ id: 'b', receivedAt: 2 });
    const out = upsertNotification([a], b);
    expect(out.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('dedupes by id and preserves the existing read flag', () => {
    const seen = rec({ id: 'a', receivedAt: 1, read: true });
    const next = rec({ id: 'a', receivedAt: 5, body: 'updated', read: false });
    const out = upsertNotification([seen], next);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ id: 'a', body: 'updated', read: true });
  });

  it('caps the log at the limit', () => {
    const list: NotificationRecord[] = [];
    for (let i = 0; i < 60; i++) list.push(rec({ id: `r-${i}`, receivedAt: i }));
    const next = rec({ id: 'newest', receivedAt: 999 });
    const out = upsertNotification(list, next, 50);
    expect(out.length).toBe(50);
    expect(out[0]?.id).toBe('newest');
  });
});

describe('markRead / markAllRead / unreadCount', () => {
  it('counts only unread entries', () => {
    expect(
      unreadCount([rec({ id: 'a', read: false }), rec({ id: 'b', read: true })]),
    ).toBe(1);
  });

  it('flips a single record to read', () => {
    const out = markRead(
      [rec({ id: 'a', read: false }), rec({ id: 'b', read: false })],
      'a',
    );
    expect(out.find((r) => r.id === 'a')?.read).toBe(true);
    expect(out.find((r) => r.id === 'b')?.read).toBe(false);
  });

  it('returns the same reference when nothing changed', () => {
    const list = [rec({ id: 'a', read: true })];
    expect(markRead(list, 'a')).toBe(list);
    expect(markAllRead(list)).toBe(list);
  });

  it('flips every record to read', () => {
    const out = markAllRead([
      rec({ id: 'a', read: false }),
      rec({ id: 'b', read: false }),
    ]);
    expect(out.every((r) => r.read)).toBe(true);
  });
});

describe('notificationTargetPathFromRecord', () => {
  it('prefers jobId over bookingId', () => {
    expect(
      notificationTargetPathFromRecord({ jobId: 'j', bookingId: 'b' }),
    ).toBe('/jobs/j');
  });
  it('routes to bookings when only bookingId is present', () => {
    expect(
      notificationTargetPathFromRecord({ jobId: null, bookingId: 'bk-7' }),
    ).toBe('/bookings/bk-7');
  });
  it('returns null when neither id is present', () => {
    expect(
      notificationTargetPathFromRecord({ jobId: null, bookingId: null }),
    ).toBeNull();
  });
});

describe('eventLabel', () => {
  it('returns friendly labels for known events', () => {
    expect(eventLabel('job_assigned')).toBe('Job assigned');
    expect(eventLabel('booking_cancelled')).toBe('Appointment cancelled');
  });
  it('falls back to a humanized version for unknown events', () => {
    expect(eventLabel('something_new')).toBe('something new');
  });
  it('returns null when no event is provided', () => {
    expect(eventLabel(null)).toBeNull();
    expect(eventLabel(undefined)).toBeNull();
  });
});

describe('shouldResetOnAuthChange', () => {
  // Regression coverage for the data-isolation fix: the in-app alert log must
  // be wiped the moment a user signs out so that a subsequent sign-in on the
  // same device (possibly as a different tenant) cannot see the previous
  // user's notifications, even though the React provider stays mounted.
  it('returns true only when auth transitions from signed-in to signed-out', () => {
    expect(shouldResetOnAuthChange(true, false)).toBe(true);
  });

  it('returns false on the initial sign-in transition', () => {
    expect(shouldResetOnAuthChange(false, true)).toBe(false);
  });

  it('returns false while the user stays signed in', () => {
    expect(shouldResetOnAuthChange(true, true)).toBe(false);
  });

  it('returns false while the user stays signed out across renders', () => {
    expect(shouldResetOnAuthChange(false, false)).toBe(false);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a log', () => {
    const log = [rec({ id: 'a' }), rec({ id: 'b', receivedAt: 2 })];
    const restored = deserializeLog(serializeLog(log));
    expect(restored.length).toBe(2);
    expect(restored.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array for missing or invalid input', () => {
    expect(deserializeLog(null)).toEqual([]);
    expect(deserializeLog(undefined)).toEqual([]);
    expect(deserializeLog('not json')).toEqual([]);
    expect(deserializeLog('{"not":"array"}')).toEqual([]);
  });

  it('drops malformed entries', () => {
    const raw = JSON.stringify([
      { id: 'good', receivedAt: 1, title: 'ok' },
      { id: '', receivedAt: 2 },
      { id: 'no-time' },
      'string-not-object',
    ]);
    const out = deserializeLog(raw);
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe('good');
  });
});
