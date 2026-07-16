import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  fanout: vi.fn(async () => undefined),
}));

vi.mock('../db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({ query: mocks.query, release: mocks.release }),
    query: mocks.query,
  }),
  withTenantContext: vi.fn(async () => undefined),
}));
vi.mock('../notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: mocks.fanout,
  filterEmailRecipientsByPreference: vi.fn(async () => []),
}));
vi.mock('../email', () => ({
  sendEmail: vi.fn(),
  escalationAlertEmail: vi.fn(() => ({ subject: '', html: '', text: '' })),
}));

import { createEscalationTask } from './HumanEscalationService';

const existingRow = {
  id: 'task-existing', tenant_id: 'tenant-1', call_session_id: 'call-1',
  agent_slug: 'healthcare-receptionist', caller_phone: '+15555550100',
  reason: 'Caller requested a human', priority: 'high', status: 'pending',
  assigned_to: null, notes: null, tool_name: 'escalate_to_human',
  metadata: { idempotencyKey: 'healthcare-receptionist:call-1:human-escalation' },
  created_at: new Date('2026-07-12T12:00:00Z'), updated_at: new Date('2026-07-12T12:00:00Z'),
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.release.mockReset();
  mocks.fanout.mockClear();
});

describe('createEscalationTask idempotency', () => {
  it('returns the existing task and does not insert or notify on a duplicate key', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM escalation_tasks') && sql.includes('idempotencyKey')) return { rows: [existingRow] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await createEscalationTask({
      tenantId: 'tenant-1' as never,
      callSessionId: 'call-1',
      agentSlug: 'healthcare-receptionist',
      callerPhone: '+15555550100',
      reason: 'Caller requested a human',
      priority: 'high',
      toolName: 'escalate_to_human',
      idempotencyKey: 'healthcare-receptionist:call-1:human-escalation',
    });

    expect(result.id).toBe('task-existing');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO escalation_tasks'))).toBe(false);
    expect(mocks.fanout).not.toHaveBeenCalled();
  });

  it('stores the idempotency key when it creates the first task', async () => {
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM escalation_tasks') && sql.includes('idempotencyKey')) return { rows: [] };
      if (sql.includes('INSERT INTO escalation_tasks')) {
        return { rows: [{ ...existingRow, id: 'task-new', metadata: JSON.parse(String(values?.[7])) }] };
      }
      if (sql.includes('SELECT id FROM tickets')) return { rows: [] };
      if (sql.includes('INSERT INTO tickets')) return { rows: [{ id: 'ticket-escalation' }] };
      if (sql.includes('INSERT INTO ticket_activity_log')) return { rows: [] };
      if (sql.includes('SELECT name FROM tenants')) return { rows: [] };
      if (sql.includes('FROM users')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await createEscalationTask({
      tenantId: 'tenant-1' as never,
      callSessionId: 'call-1',
      reason: 'Caller requested a human',
      priority: 'high',
      toolName: 'escalate_to_human',
      idempotencyKey: 'healthcare-receptionist:call-1:human-escalation',
    });

    expect(result.id).toBe('task-new');
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO escalation_tasks'));
    expect(JSON.parse(String(insert?.[1]?.[7]))).toMatchObject({
      idempotencyKey: 'healthcare-receptionist:call-1:human-escalation',
    });
    const ticketInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO tickets'));
    expect(ticketInsert?.[1]).toEqual(expect.arrayContaining([
      'tenant-1', 'call-1', expect.stringContaining('Caller requested a human'), 'high',
    ]));
  });

  it('reuses an existing call ticket instead of creating duplicate staff work', async () => {
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM escalation_tasks') && sql.includes('idempotencyKey')) return { rows: [] };
      if (sql.includes('INSERT INTO escalation_tasks')) return { rows: [{ ...existingRow, id: 'task-new', metadata: JSON.parse(String(values?.[7])) }] };
      if (sql.includes('SELECT id FROM tickets')) return { rows: [{ id: 'ticket-existing' }] };
      if (sql.includes('SELECT name FROM tenants')) return { rows: [] };
      if (sql.includes('FROM users')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await createEscalationTask({
      tenantId: 'tenant-1' as never, callSessionId: 'call-1', reason: 'Caller requested a human',
      priority: 'high', toolName: 'escalate_to_human',
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO tickets'))).toBe(false);
  });
});
