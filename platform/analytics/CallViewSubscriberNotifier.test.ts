import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  sendEmailMock,
  filterRecipientsMock,
  filterUserIdsMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendEmailMock: vi.fn(),
  filterRecipientsMock: vi.fn(async (_t: string, e: string[]) => e),
  filterUserIdsMock: vi.fn(async (ids: string[]) => ids),
}));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../email/EmailService', () => ({
  sendEmail: sendEmailMock,
}));

vi.mock('../notifications/NotificationPreferences', () => ({
  filterEmailRecipientsByPreference: filterRecipientsMock,
  filterUserIdsByPreference: filterUserIdsMock,
}));

import { notifySubscriberChanges } from './CallViewSubscriberNotifier';

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  filterRecipientsMock.mockClear();
  filterRecipientsMock.mockImplementation(async (_t: string, e: string[]) => e);
  filterUserIdsMock.mockClear();
  filterUserIdsMock.mockImplementation(async (ids: string[]) => ids);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('notifySubscriberChanges opt-out', () => {
  // Regression: locks in the call-view subscriber opt-out filter contract.
  // The added/removed digest emails must route recipients through the
  // 'call' email opt-out filter. If a future refactor stops calling the
  // filter, this test fails.
  it('inserts in-app rows but skips sending email when subscribers opted out of call emails', async () => {
    // 1. lookupUserIdsByEmail SELECT users — return matching user rows
    //    for both the added and removed recipients so they're eligible
    //    for the in-app insert path.
    queryMock.mockImplementationOnce(async () => ({
      rows: [
        { id: 'u-bob', email: 'bob@example.com' },
        { id: 'u-carol', email: 'carol@example.com' },
      ],
    }));
    // 2. INSERT tenant_notifications for the added recipient.
    queryMock.mockImplementationOnce(async () => ({ rowCount: 1 }));
    // 3. INSERT tenant_notifications for the removed recipient.
    queryMock.mockImplementationOnce(async () => ({ rowCount: 1 }));

    // Email filter: drop everyone (both calls — added then removed).
    filterRecipientsMock.mockResolvedValueOnce([]);
    filterRecipientsMock.mockResolvedValueOnce([]);

    await notifySubscriberChanges({
      tenantId: 'tenant-optout',
      viewId: 'view-1',
      viewName: 'Pipeline VIPs',
      actorUserId: null,
      actorEmail: 'alice@example.com',
      added: ['bob@example.com'],
      removed: ['carol@example.com'],
    });

    // Filter must be invoked with the 'call' category for both flows.
    expect(filterRecipientsMock).toHaveBeenCalledTimes(2);
    expect(filterRecipientsMock).toHaveBeenNthCalledWith(
      1,
      'tenant-optout',
      ['bob@example.com'],
      'call',
    );
    expect(filterRecipientsMock).toHaveBeenNthCalledWith(
      2,
      'tenant-optout',
      ['carol@example.com'],
      'call',
    );

    // Email side effects must NOT fire.
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Other side effects still happen: per-user in-app inbox rows are
    // inserted (subject to per-user 'call' in-app preferences via
    // filterUserIdsMock, which we left as identity).
    const insertCalls = queryMock.mock.calls.filter((c) =>
      typeof c[0] === 'string' && /INSERT INTO tenant_notifications/.test(c[0]),
    );
    expect(insertCalls).toHaveLength(2);
    // First insert is for the 'added' subscriber (bob), second for
    // 'removed' (carol). Both rows carry the 'call' notification type.
    expect(insertCalls[0][1]).toEqual([
      'tenant-optout',
      'u-bob',
      'call',
      expect.stringContaining('Subscribed'),
      expect.any(String),
      expect.any(String),
    ]);
    expect(insertCalls[1][1]).toEqual([
      'tenant-optout',
      'u-carol',
      'call',
      expect.stringContaining('Removed'),
      expect.any(String),
      expect.any(String),
    ]);
  });
});
