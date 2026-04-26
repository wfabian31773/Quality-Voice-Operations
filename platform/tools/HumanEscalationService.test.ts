import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  sendEmailMock,
  escalationAlertEmailMock,
  fanoutMock,
  filterRecipientsMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendEmailMock: vi.fn(),
  escalationAlertEmailMock: vi.fn(() => ({
    subject: 'Human escalation',
    html: '<p>html</p>',
    text: 'text',
  })),
  fanoutMock: vi.fn().mockResolvedValue(undefined),
  filterRecipientsMock: vi.fn(async (_t: string, e: string[]) => e),
}));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withTenantContext: vi.fn(async () => undefined),
}));

vi.mock('../email', () => ({
  sendEmail: sendEmailMock,
  escalationAlertEmail: escalationAlertEmailMock,
}));

vi.mock('../notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: fanoutMock,
  filterEmailRecipientsByPreference: filterRecipientsMock,
}));

import { notifyHumanEscalation, type EscalationTask } from './HumanEscalationService';

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  fanoutMock.mockClear();
  filterRecipientsMock.mockClear();
  filterRecipientsMock.mockImplementation(async (_t: string, e: string[]) => e);
  escalationAlertEmailMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeTask(overrides: Partial<EscalationTask> = {}): EscalationTask {
  return {
    id: 'task-1',
    tenantId: 'tenant-optout',
    callSessionId: 'call-1',
    agentSlug: 'support',
    callerPhone: '+15551234567',
    reason: 'Caller asked for a human',
    priority: 'high',
    status: 'pending',
    assignedTo: null,
    notes: null,
    toolName: 'transfer_to_human',
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('notifyHumanEscalation opt-out', () => {
  // Regression: locks in the human-escalation opt-out filter contract.
  // Pages routed through `notifyHumanEscalation` must run recipients
  // through `filterEmailRecipientsByPreference` with the 'escalation'
  // category. If a future refactor stops calling the filter, this test
  // fails.
  it('fans out in-app but skips sending email when admins opted out of escalation emails', async () => {
    // 1. SELECT name FROM tenants
    queryMock.mockImplementationOnce(async () => ({ rows: [{ name: 'Acme' }] }));
    // 2. SELECT email FROM users WHERE role IN ('admin', 'owner')
    queryMock.mockImplementationOnce(async () => ({
      rows: [
        { email: 'owner@acme.test' },
        { email: 'admin@acme.test' },
      ],
    }));

    filterRecipientsMock.mockResolvedValueOnce([]);

    await notifyHumanEscalation(makeTask());

    // Filter must be invoked with the 'escalation' category.
    expect(filterRecipientsMock).toHaveBeenCalledTimes(1);
    expect(filterRecipientsMock).toHaveBeenCalledWith(
      'tenant-optout',
      ['owner@acme.test', 'admin@acme.test'],
      'escalation',
    );

    // Email side effects must NOT fire.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(escalationAlertEmailMock).not.toHaveBeenCalled();

    // Other side effects still happen: in-app fan-out runs first so
    // per-user 'escalation' in-app preferences still get a chance to
    // surface the page in the inbox.
    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-optout',
      type: 'escalation',
      category: 'escalation',
      metadata: expect.objectContaining({
        escalationTaskId: 'task-1',
        callSessionId: 'call-1',
        priority: 'high',
      }),
    });
  });
});
