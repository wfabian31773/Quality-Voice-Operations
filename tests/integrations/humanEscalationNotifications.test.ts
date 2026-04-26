import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>
>();
const sendEmailMock = vi.fn<
  (input: { to: string; subject: string; html: string; text?: string }) => Promise<{ success: boolean; error?: string }>
>();
const escalationTemplateMock = vi.fn<
  (input: Record<string, unknown>) => { subject: string; html: string; text: string }
>();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  // notifyHumanEscalation never opens a transaction itself, so we only need a
  // no-op tenant context shim for safety in case any helper reaches for it.
  withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../platform/email', () => ({
  sendEmail: (input: { to: string; subject: string; html: string; text?: string }) =>
    sendEmailMock(input),
  escalationAlertEmail: (input: Record<string, unknown>) => escalationTemplateMock(input),
}));

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  escalationTemplateMock.mockReset();
  escalationTemplateMock.mockReturnValue({
    subject: 'escalation-subject',
    html: 'escalation-html',
    text: 'escalation-text',
  });
});

// notifyHumanEscalation query order:
//   1. fanoutInAppNotification: SELECT active tenant users
//   2. filterUserIdsByPreference: SELECT in_app preferences for those users
//   3. INSERT tenant_notifications per opted-in user (one query each)
//   4. SELECT tenant name
//   5. SELECT admin/owner email recipients
//   6. filterEmailRecipientsByPreference: SELECT email preferences

describe('notifyHumanEscalation', () => {
  const baseTask = {
    id: 'task-1',
    tenantId: 'tenant-1',
    callSessionId: 'call-1',
    agentSlug: 'agent-x',
    callerPhone: '+15551234567',
    reason: 'Customer is upset and asked for a manager',
    priority: 'high' as const,
    status: 'pending' as const,
    assignedTo: null,
    notes: null,
    toolName: null,
    metadata: {},
    createdAt: new Date('2026-04-25T15:30:00Z').toISOString(),
    updatedAt: new Date('2026-04-25T15:30:00Z').toISOString(),
  };

  it('skips users opted out of escalation alerts but still notifies the rest, in-app and email', async () => {
    queryMock
      // 1. tenant active users for in-app fan-out
      .mockResolvedValueOnce({
        rows: [{ id: 'user-a' }, { id: 'user-b' }, { id: 'user-c' }],
      })
      // 2. in_app preference filter — user-b has explicitly opted OUT of escalation in-app
      .mockResolvedValueOnce({
        rows: [{ user_id: 'user-b', enabled: false }],
      })
      // 3. INSERT for user-a
      .mockResolvedValueOnce({ rows: [] })
      // 3. INSERT for user-c
      .mockResolvedValueOnce({ rows: [] })
      // 4. tenant name lookup
      .mockResolvedValueOnce({ rows: [{ name: 'Acme Co' }] })
      // 5. admin recipient lookup
      .mockResolvedValueOnce({
        rows: [
          { email: 'alice@acme.test' },
          { email: 'bob@acme.test' },
          { email: 'carol@acme.test' },
        ],
      })
      // 6. email preference filter — bob opted OUT of escalation emails, alice/carol opted in (or default)
      .mockResolvedValueOnce({
        rows: [
          { email: 'alice@acme.test', enabled: true },
          { email: 'bob@acme.test', enabled: false },
          { email: 'carol@acme.test', enabled: null },
        ],
      });

    const { notifyHumanEscalation } = await import(
      '../../platform/tools/HumanEscalationService'
    );

    await notifyHumanEscalation(baseTask);

    // In-app: only user-a and user-c get a tenant_notifications row.
    const insertCalls = queryMock.mock.calls.filter(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls).toHaveLength(2);
    const insertedUserIds = insertCalls
      .map(([, params]) => (Array.isArray(params) ? (params[1] as string) : ''))
      .sort();
    expect(insertedUserIds).toEqual(['user-a', 'user-c']);

    // Every insert is tagged with type='escalation' so the admin console can
    // group them and so categoryForNotificationType can map them back to the
    // user-facing preference category.
    for (const [, params] of insertCalls) {
      expect(Array.isArray(params)).toBe(true);
      const args = params as unknown[];
      expect(args[0]).toBe('tenant-1'); // tenant id
      expect(args[2]).toBe('escalation'); // type column
    }

    // The in_app preference filter must run against the 'escalation' category
    // (not, say, 'integration'), otherwise the opt-out toggle on the
    // preferences panel does nothing.
    const prefFilterCall = queryMock.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM user_notification_preferences') &&
        sql.includes('channel = $2'),
    );
    expect(prefFilterCall).toBeDefined();
    expect((prefFilterCall as unknown[])[1]).toEqual([
      'escalation',
      'in_app',
      ['user-a', 'user-b', 'user-c'],
    ]);

    // Email: alice and carol only — bob is dropped by the preference filter.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const recipients = sendEmailMock.mock.calls
      .map(([msg]) => msg.to)
      .sort();
    expect(recipients).toEqual(['alice@acme.test', 'carol@acme.test']);

    // The email preference filter must also be scoped to 'escalation'.
    const emailFilterCall = queryMock.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('LEFT JOIN user_notification_preferences'),
    );
    expect(emailFilterCall).toBeDefined();
    const emailFilterParams = (emailFilterCall as unknown[])[1] as unknown[];
    expect(emailFilterParams[0]).toBe('tenant-1');
    expect(emailFilterParams[2]).toBe('escalation');

    // The escalation email template gets the tenant name and full task context.
    expect(escalationTemplateMock).toHaveBeenCalledTimes(1);
    const templateArg = escalationTemplateMock.mock.calls[0][0];
    expect(templateArg.tenantName).toBe('Acme Co');
    expect(templateArg.priority).toBe('high');
    expect(templateArg.callSessionId).toBe('call-1');
  });

  it('emails every admin/owner (no arbitrary cap) and uses deterministic ordering so the on-call roster matches dispatch', async () => {
    // 12 admin/owner accounts — historically this path capped at 10 with
    // no ordering, which made the on-call roster panel misleading for
    // tenants with many admins. Dispatch must now match listEscalationRecipients.
    const adminEmails = Array.from({ length: 12 }, (_, i) => ({ email: `admin${i + 1}@acme.test` }));

    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // tenant active users
      .mockResolvedValueOnce({ rows: [] }) // in_app preference filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT for user-a
      .mockResolvedValueOnce({ rows: [{ name: 'Acme Co' }] }) // tenant name
      .mockResolvedValueOnce({ rows: adminEmails }) // admin recipient lookup
      .mockResolvedValueOnce({ rows: [] }); // email preference filter (nobody opted out)

    const { notifyHumanEscalation } = await import(
      '../../platform/tools/HumanEscalationService'
    );

    await notifyHumanEscalation(baseTask);

    // All 12 admins receive the escalation email — no LIMIT 10 cap.
    expect(sendEmailMock).toHaveBeenCalledTimes(12);

    // The admin recipient lookup query must be ordered deterministically
    // (owners — including the canonical tenant_owner role — first, then
    // case-insensitive email) so the roster endpoint and the dispatcher
    // always agree on who appears in the rotation. The query must also
    // reach through the `user_roles` join so tenant_owner /
    // operations_manager users who only carry the role via the canonical
    // RBAC table still get paged.
    const adminLookupCall = queryMock.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM users u') &&
        sql.includes('LEFT JOIN user_roles ur'),
    );
    expect(adminLookupCall).toBeDefined();
    const sql = (adminLookupCall as unknown[])[0] as string;
    expect(sql).toContain("ur.role IN ('tenant_owner', 'operations_manager')");
    expect(sql).toContain(
      "u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')",
    );
    expect(sql).toMatch(
      /ORDER BY[\s\S]*CASE WHEN u\.role IN \('owner', 'tenant_owner'\) THEN 0 ELSE 1 END[\s\S]*LOWER\(u\.email\) ASC/,
    );
    expect(sql).not.toMatch(/LIMIT\s+10/i);
  });

  it('reaches a recipient who only holds the tenant_owner role via user_roles', async () => {
    // Regression for task #420: before broadening this lookup the dispatcher
    // gated on `users.role IN ('admin', 'owner')`, which silently dropped
    // tenant owners and operations managers whose role was assigned through
    // the canonical `user_roles` table. The shared connector helper already
    // handled this audience; the human-escalation path must too.
    queryMock
      // 1. tenant active users for in-app fan-out
      .mockResolvedValueOnce({ rows: [{ id: 'user-rbac-only' }] })
      // 2. in_app preference filter — nobody opted out
      .mockResolvedValueOnce({ rows: [] })
      // 3. INSERT for the in-app row
      .mockResolvedValueOnce({ rows: [] })
      // 4. tenant name
      .mockResolvedValueOnce({ rows: [{ name: 'Acme Co' }] })
      // 5. admin recipient lookup — the tenant_owner only carries the role
      //    through user_roles, so `users.role` is something benign like
      //    'member'. The join in the new query is what surfaces them.
      .mockResolvedValueOnce({
        rows: [{ email: 'rbac-owner@acme.test', role: 'member' }],
      })
      // 6. email preference filter — no opt-outs
      .mockResolvedValueOnce({ rows: [] });

    const { notifyHumanEscalation } = await import(
      '../../platform/tools/HumanEscalationService'
    );

    await notifyHumanEscalation(baseTask);

    // The recipient who only matched via user_roles still got an email.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe('rbac-owner@acme.test');

    // And the SQL we ran really does query through user_roles with the
    // canonical role values, so this stays a true regression test rather
    // than a no-op assertion.
    const adminLookupCall = queryMock.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('FROM users u') &&
        sql.includes('LEFT JOIN user_roles ur'),
    );
    expect(adminLookupCall).toBeDefined();
    const sql = (adminLookupCall as unknown[])[0] as string;
    expect(sql).toContain("ur.role IN ('tenant_owner', 'operations_manager')");
    expect(sql).toContain(
      "u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')",
    );
  });

  it('sends to everyone when no preferences are stored (default-on)', async () => {
    queryMock
      // 1. tenant active users
      .mockResolvedValueOnce({
        rows: [{ id: 'user-a' }, { id: 'user-b' }],
      })
      // 2. in_app preference filter — empty rows means nobody opted out
      .mockResolvedValueOnce({ rows: [] })
      // 3. inserts
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // 4. tenant name
      .mockResolvedValueOnce({ rows: [{ name: 'Acme Co' }] })
      // 5. admin emails
      .mockResolvedValueOnce({
        rows: [{ email: 'alice@acme.test' }, { email: 'bob@acme.test' }],
      })
      // 6. email preference filter — no opt-outs
      .mockResolvedValueOnce({ rows: [] });

    const { notifyHumanEscalation } = await import(
      '../../platform/tools/HumanEscalationService'
    );

    await notifyHumanEscalation(baseTask);

    const insertCalls = queryMock.mock.calls.filter(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls).toHaveLength(2);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });
});
