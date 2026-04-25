import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

beforeEach(() => {
  queryMock.mockReset();
});

describe('categoryForNotificationType', () => {
  it('maps known notification types to their categories', async () => {
    const { categoryForNotificationType } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    expect(categoryForNotificationType('call')).toBe('call');
    expect(categoryForNotificationType('integration')).toBe('integration');
    expect(categoryForNotificationType('integration_sms')).toBe('sms');
    expect(categoryForNotificationType('sms')).toBe('sms');
    expect(categoryForNotificationType('escalation')).toBe('escalation');
    expect(categoryForNotificationType('account_suspended')).toBe('billing');
    expect(categoryForNotificationType('usage_warning_minutes')).toBe('billing');
    expect(categoryForNotificationType('billing_invoice_failed')).toBe('billing');
  });

  it('returns null for unknown or campaign-only types', async () => {
    const { categoryForNotificationType } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    expect(categoryForNotificationType('campaign')).toBeNull();
    expect(categoryForNotificationType('something_else')).toBeNull();
    expect(categoryForNotificationType('')).toBeNull();
    expect(categoryForNotificationType(null)).toBeNull();
    expect(categoryForNotificationType(undefined)).toBeNull();
  });
});

describe('getUserPreferences', () => {
  it('returns the all-enabled default matrix when no rows exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { getUserPreferences } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const matrix = await getUserPreferences('user-1');
    expect(matrix).toEqual({
      call: { in_app: true, email: true },
      billing: { in_app: true, email: true },
      sms: { in_app: true, email: true },
      integration: { in_app: true, email: true },
      escalation: { in_app: true, email: true },
    });
  });

  it('overlays stored rows on top of the defaults', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { category: 'billing', channel: 'email', enabled: false },
        { category: 'call', channel: 'in_app', enabled: false },
        { category: 'bogus', channel: 'in_app', enabled: false },
        { category: 'call', channel: 'pager', enabled: false },
      ],
    });
    const { getUserPreferences } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const matrix = await getUserPreferences('user-1');
    expect(matrix.billing.email).toBe(false);
    expect(matrix.billing.in_app).toBe(true);
    expect(matrix.call.in_app).toBe(false);
    expect(matrix.call.email).toBe(true);
    expect(matrix.escalation.email).toBe(true);
  });

  it('falls back to defaults if the query throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const { getUserPreferences } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const matrix = await getUserPreferences('user-1');
    expect(matrix.call.in_app).toBe(true);
    expect(matrix.billing.email).toBe(true);
  });
});

describe('isChannelEnabled', () => {
  it('returns true when no row is stored', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { isChannelEnabled } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    await expect(isChannelEnabled('user-1', 'billing', 'email')).resolves.toBe(true);
  });

  it('returns the stored value when present', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ enabled: false }] });
    const { isChannelEnabled } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    await expect(isChannelEnabled('user-1', 'billing', 'email')).resolves.toBe(false);
  });

  it('returns true for missing user ids without hitting the database', async () => {
    const { isChannelEnabled } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    await expect(isChannelEnabled(null, 'billing', 'email')).resolves.toBe(true);
    await expect(isChannelEnabled(undefined, 'billing', 'email')).resolves.toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns true on database error so alerts are never silenced by a broken table', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    const { isChannelEnabled } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    await expect(isChannelEnabled('user-1', 'billing', 'email')).resolves.toBe(true);
  });
});

describe('filterUserIdsByPreference', () => {
  it('keeps users with no row and drops users explicitly opted out', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { user_id: 'user-2', enabled: false },
        { user_id: 'user-3', enabled: true },
      ],
    });
    const { filterUserIdsByPreference } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const result = await filterUserIdsByPreference(
      ['user-1', 'user-2', 'user-3', 'user-1'],
      'call',
      'in_app',
    );
    expect(result.sort()).toEqual(['user-1', 'user-3']);
  });

  it('returns an empty array for an empty input list without querying', async () => {
    const { filterUserIdsByPreference } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const result = await filterUserIdsByPreference([], 'call', 'in_app');
    expect(result).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('falls back to all users when the database errors', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    const { filterUserIdsByPreference } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const result = await filterUserIdsByPreference(['user-1', 'user-2'], 'call', 'in_app');
    expect(result.sort()).toEqual(['user-1', 'user-2']);
  });
});

describe('filterEmailRecipientsByPreference', () => {
  it('preserves all recipients when nobody has opted out', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { email: 'alice@example.com', enabled: true },
        { email: 'bob@example.com', enabled: null },
      ],
    });
    const { filterEmailRecipientsByPreference } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const result = await filterEmailRecipientsByPreference(
      'tenant-1',
      ['Alice@example.com', 'bob@example.com', 'external@vendor.com'],
      'billing',
    );
    expect(result).toEqual(['Alice@example.com', 'bob@example.com', 'external@vendor.com']);
  });

  it('drops recipients whose user has explicitly opted out', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { email: 'alice@example.com', enabled: false },
        { email: 'bob@example.com', enabled: true },
      ],
    });
    const { filterEmailRecipientsByPreference } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const result = await filterEmailRecipientsByPreference(
      'tenant-1',
      ['Alice@example.com', 'bob@example.com', 'external@vendor.com'],
      'billing',
    );
    expect(result).toEqual(['bob@example.com', 'external@vendor.com']);
  });

  it('returns the cleaned list on database error to avoid silent drops', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    const { filterEmailRecipientsByPreference } = await import(
      '../../platform/notifications/NotificationPreferences'
    );
    const result = await filterEmailRecipientsByPreference(
      'tenant-1',
      ['alice@example.com', 'bob@example.com'],
      'billing',
    );
    expect(result).toEqual(['alice@example.com', 'bob@example.com']);
  });
});
