import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import {
  listConversations, getConversation, updateConversation, markConversationRead, listMessages,
  addInternalNote, listInternalNotes, createCannedResponse, listCannedResponses, updateCannedResponse,
  deleteCannedResponse, substituteVariables, logActivity, listActivityLog, getConsentHistory,
  getInboxCounts, bulkUpdateConversations,
} from './SmsConversationService';

// Build a SQL-dispatching query handler. Transaction control + the
// withTenantContext no-op resolve to empty; matchers map a SQL fragment to a
// result, first match wins.
function dispatch(matchers: Array<[string | RegExp, { rows?: unknown[]; rowCount?: number }]>) {
  a.clientQueryMock.mockImplementation(async (sql: string) => {
    for (const [needle, result] of matchers) {
      const hit = typeof needle === 'string' ? sql.includes(needle) : needle.test(sql);
      if (hit) return { rows: result.rows ?? [], rowCount: result.rowCount ?? (result.rows?.length ?? 0) };
    }
    return { rows: [], rowCount: 0 };
  });
}

const convRow = {
  id: 'cv1', tenant_id: 't1', phone_number_id: 'pn1', remote_number: '+15551230000', status: 'open',
  assignee_user_id: null, assignee_team: null, priority: 'normal', pinned: false, unread_count: '2',
  follow_up: false, follow_up_at: null, last_message_at: '2026-01-01T00:00:00Z', last_message_preview: 'hi',
  closed_at: null, escalated_at: null, contact_name: 'Ada', contact_email: null, contact_location: null,
  tags: [], metadata: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
});

describe('listConversations', () => {
  it('returns conversations and the total, applying filters', async () => {
    dispatch([
      ['COUNT(*)::int AS total', { rows: [{ total: 1 }] }],
      ['SELECT c.* FROM sms_conversations', { rows: [convRow] }],
    ]);
    const res = await listConversations('t1', { status: 'open', unreadOnly: true, search: 'ada', deferredOnly: true });
    expect(res.total).toBe(1);
    expect(res.conversations[0]).toMatchObject({ id: 'cv1', unreadCount: 2, contactName: 'Ada' });
  });
});

describe('getConversation', () => {
  it('maps the row when found', async () => {
    dispatch([['FROM sms_conversations WHERE id', { rows: [convRow] }]]);
    expect((await getConversation('t1', 'cv1'))?.id).toBe('cv1');
  });
  it('returns null when missing', async () => {
    dispatch([['FROM sms_conversations WHERE id', { rows: [] }]]);
    expect(await getConversation('t1', 'cv1')).toBeNull();
  });
});

describe('updateConversation', () => {
  it('builds the SET clause and returns the updated row (status=closed)', async () => {
    dispatch([['UPDATE sms_conversations SET', { rows: [{ ...convRow, status: 'closed' }] }]]);
    const res = await updateConversation('t1', 'cv1', { status: 'closed', pinned: true, tags: ['vip'] });
    expect(res?.status).toBe('closed');
    const call = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE sms_conversations SET'));
    expect(String(call?.[0])).toContain('closed_at = NOW()');
  });
  it('returns null when no row is updated', async () => {
    dispatch([['UPDATE sms_conversations SET', { rows: [] }]]);
    expect(await updateConversation('t1', 'cv1', { priority: 'high' })).toBeNull();
  });
});

describe('markConversationRead', () => {
  it('zeroes the unread count', async () => {
    await markConversationRead('t1', 'cv1');
    const call = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('unread_count = 0'));
    expect(call).toBeTruthy();
  });
});

describe('listMessages', () => {
  it('returns mapped messages and the total', async () => {
    dispatch([
      ['COUNT(*)::int AS total FROM sms_messages', { rows: [{ total: 1 }] }],
      ['SELECT * FROM sms_messages', { rows: [{ id: 'm1', tenant_id: 't1', conversation_id: 'cv1', direction: 'inbound', from_number: '+1', to_number: '+2', body: 'hi', status: 'received', twilio_sid: null, scheduled_at: null, sent_at: null, delivered_at: null, error_message: null, metadata: {}, created_at: '2026-01-01T00:00:00Z' }] }],
    ]);
    const res = await listMessages('t1', 'cv1');
    expect(res.total).toBe(1);
    expect(res.messages[0]).toMatchObject({ id: 'm1', direction: 'inbound', body: 'hi' });
  });
});

describe('internal notes', () => {
  it('adds a note', async () => {
    dispatch([['INSERT INTO sms_internal_notes', { rows: [{ id: 'n1', tenant_id: 't1', conversation_id: 'cv1', user_id: 'u1', user_name: 'Op', body: 'note', created_at: '2026-01-01T00:00:00Z' }] }]]);
    expect((await addInternalNote('t1', 'cv1', 'u1', 'Op', 'note')).id).toBe('n1');
  });
  it('lists notes', async () => {
    dispatch([['FROM sms_internal_notes', { rows: [{ id: 'n1', tenant_id: 't1', conversation_id: 'cv1', user_id: 'u1', user_name: 'Op', body: 'note', created_at: '2026-01-01T00:00:00Z' }] }]]);
    expect(await listInternalNotes('t1', 'cv1')).toHaveLength(1);
  });
});

describe('canned responses', () => {
  const cr = { id: 'c1', tenant_id: 't1', title: 'Greeting', body: 'Hi {{name}}', category: null, variables: ['name'], shortcut: null, created_by: null, is_global: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  it('creates one', async () => {
    dispatch([['INSERT INTO sms_canned_responses', { rows: [cr] }]]);
    expect((await createCannedResponse('t1', { title: 'Greeting', body: 'Hi {{name}}' })).id).toBe('c1');
  });
  it('lists them', async () => {
    dispatch([['FROM sms_canned_responses', { rows: [cr] }]]);
    expect(await listCannedResponses('t1')).toHaveLength(1);
  });
  it('updates one', async () => {
    dispatch([['UPDATE sms_canned_responses SET', { rows: [{ ...cr, title: 'Renamed' }] }]]);
    expect((await updateCannedResponse('t1', 'c1', { title: 'Renamed' }))?.title).toBe('Renamed');
  });
  it('returns null updating a missing one', async () => {
    dispatch([['UPDATE sms_canned_responses SET', { rows: [] }]]);
    expect(await updateCannedResponse('t1', 'c1', { body: 'x' })).toBeNull();
  });
  it('deletes one', async () => {
    dispatch([['DELETE FROM sms_canned_responses', { rowCount: 1 }]]);
    expect(await deleteCannedResponse('t1', 'c1')).toBe(true);
  });
  it('reports no delete when absent', async () => {
    dispatch([['DELETE FROM sms_canned_responses', { rowCount: 0 }]]);
    expect(await deleteCannedResponse('t1', 'c1')).toBe(false);
  });
});

describe('substituteVariables', () => {
  it('replaces known tokens and leaves unknown ones', async () => {
    expect(await substituteVariables('Hi {{name}}, code {{code}}', { name: 'Ada' })).toBe('Hi Ada, code {{code}}');
  });
});

describe('activity + consent', () => {
  it('logs activity', async () => {
    await logActivity('t1', 'cv1', 'assigned', 'u1', 'Op', { to: 'u2' });
    const call = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO sms_conversation_activity_log'));
    expect(call).toBeTruthy();
  });
  it('lists the activity log', async () => {
    dispatch([['FROM sms_conversation_activity_log', { rows: [{ id: 'l1', action: 'assigned', actor_name: 'Op', details: { to: 'u2' }, created_at: '2026-01-01T00:00:00Z' }] }]]);
    expect((await listActivityLog('t1', 'cv1'))[0]).toMatchObject({ action: 'assigned', actorName: 'Op' });
  });
  it('returns consent history', async () => {
    dispatch([['FROM sms_consent_log', { rows: [{ action: 'opt_out', keyword: 'STOP', source: 'inbound_sms', created_at: '2026-01-01T00:00:00Z' }] }]]);
    expect((await getConsentHistory('t1', '+1'))[0]).toMatchObject({ action: 'opt_out', keyword: 'STOP' });
  });
});

describe('getInboxCounts', () => {
  it('aggregates status, unread, and deferred counts', async () => {
    dispatch([
      ['GROUP BY status', { rows: [{ status: 'open', count: 3 }, { status: 'closed', count: 1 }] }],
      ['unread_count > 0', { rows: [{ count: 2 }] }],
      ['COUNT(DISTINCT m.id)', { rows: [{ count: 5 }] }],
    ]);
    const counts = await getInboxCounts('t1');
    expect(counts).toMatchObject({ open: 3, closed: 1, unread: 2, deferred: 5 });
  });
});

describe('bulkUpdateConversations', () => {
  it('returns the affected row count', async () => {
    dispatch([['UPDATE sms_conversations SET', { rowCount: 4 }]]);
    expect(await bulkUpdateConversations('t1', ['a', 'b'], { status: 'closed' })).toBe(4);
  });
});
