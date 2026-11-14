import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  SMS_INBOX_BULK_ID_LIMIT,
  smsInboxReplyIdempotencyKey,
} from './smsInboxSchemas';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  poolQueryMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  sendUserSms: vi.fn(),
  sendStoredSms: vi.fn(),
  isOnDnc: vi.fn(),
  sms: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// requireMiniSystemWrite is real (pure); operations_manager is allowed to write.
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock }) }));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/sms/SmsConversationService', () => a.sms);
vi.mock('../../../platform/actions/sms', () => ({
  SMS_MAX_BODY_CHARS: 640,
  sendUserSms: (...args: unknown[]) => a.sendUserSms(...args),
  sendStoredSms: (...args: unknown[]) => a.sendStoredSms(...args),
}));
vi.mock('../../../platform/campaigns/DncService', () => ({
  isOnDnc: (...args: unknown[]) => a.isOnDnc(...args),
}));
vi.mock('../../../platform/sms/SmsQuietHours', () => ({
  evaluateSmsQuietHoursForTenant: vi.fn(async () => ({
    allowed: true,
    timezone: 'America/Chicago',
    localTimeIso: '2026-04-28T13:00:00',
  })),
  getEffectiveSmsQuietHoursWindow: vi.fn(async () => ({ start: '08:00', end: '21:00', isTenantOverride: false })),
  formatSmsQuietHoursWindow: vi.fn(() => '08:00–21:00 local'),
  nextSmsWindowStartForTenant: vi.fn(async () => new Date('2026-04-29T12:00:00Z')),
  SMS_QUIET_HOURS_WINDOW_START: '08:00',
  SMS_QUIET_HOURS_WINDOW_END: '21:00',
}));

import router from './smsInbox';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const ownThread = {
  id: 'cv1',
  tenantId: 't1',
  phoneNumberId: 'pn1',
  remoteNumber: '+15555550142',
  status: 'open' as const,
  assigneeUserId: null as string | null,
  assigneeTeam: null as string | null,
};

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.tenantId = 't1';
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  a.sendUserSms.mockReset().mockResolvedValue({ ok: true, data: { messageId: 'm-sent', status: 'queued' } });
  a.sendStoredSms.mockReset();
  a.isOnDnc.mockReset().mockResolvedValue(false);
  a.sms.listConversations = vi.fn().mockResolvedValue({ conversations: [], total: 0 });
  a.sms.getConversation = vi.fn();
  a.sms.updateConversation = vi.fn().mockResolvedValue({ id: 'cv1' });
  a.sms.listMessages = vi.fn().mockResolvedValue({ messages: [], total: 0 });
  a.sms.markConversationRead = vi.fn().mockResolvedValue(undefined);
  a.sms.logActivity = vi.fn().mockResolvedValue(undefined);
  a.sms.getMessage = vi.fn().mockResolvedValue({ id: 'm-sent', body: 'hi' });
  a.sms.addInternalNote = vi.fn().mockResolvedValue({ id: 'n1', body: 'note' });
  a.sms.bulkUpdateConversations = vi.fn().mockImplementation(async (_tenant: string, ids: string[]) => ids.length);
  a.sms.createCannedResponse = vi.fn().mockResolvedValue({ id: 'tpl1' });
  a.sms.updateCannedResponse = vi.fn().mockResolvedValue({ id: 'tpl1' });
  a.sms.deleteCannedResponse = vi.fn().mockResolvedValue(true);
  a.sms.substituteVariables = vi.fn().mockResolvedValue('Hello');
  a.sms.createAutoReplyRule = vi.fn().mockResolvedValue({ id: 'ar1' });
  a.sms.updateAutoReplyRule = vi.fn().mockResolvedValue({ id: 'ar1' });
  a.sms.deleteAutoReplyRule = vi.fn().mockResolvedValue(true);
  a.sms.createAssignmentRule = vi.fn().mockResolvedValue({ id: 'as1' });
  a.sms.deleteAssignmentRule = vi.fn().mockResolvedValue(true);
});

describe('GET /sms-inbox/conversations (phone lines)', () => {
  it('lists phone lines from the DB', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 'pn1', phone_number: '+15555550100', friendly_name: 'Main' }] });
    const res = await request(app()).get('/sms-inbox/conversations');
    expect(res.status).toBe(200);
    expect(res.body.conversations[0]).toMatchObject({ phoneNumberId: 'pn1' });
  });
});

describe('GET /sms-inbox/threads (conversations)', () => {
  it('rejects an invalid status filter', async () => {
    expect((await request(app()).get('/sms-inbox/threads?status=weird')).status).toBe(400);
  });
  it('rejects an invalid priority filter', async () => {
    expect((await request(app()).get('/sms-inbox/threads?priority=nuclear')).status).toBe(400);
  });
  it('lists conversations', async () => {
    a.sms.listConversations.mockResolvedValue({ conversations: [{ id: 'cv1' }], total: 1 });
    const res = await request(app()).get('/sms-inbox/threads?status=open&unread=true');
    expect(res.body.total).toBe(1);
  });
  it('500 on failure', async () => {
    a.sms.listConversations.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/sms-inbox/threads')).status).toBe(500);
  });
});

describe('GET /sms-inbox/threads/:id', () => {
  it('404 when missing', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    expect((await request(app()).get('/sms-inbox/threads/cv1')).status).toBe(404);
  });
  it('returns the conversation', async () => {
    a.sms.getConversation.mockResolvedValue({ id: 'cv1' });
    expect((await request(app()).get('/sms-inbox/threads/cv1')).body.conversation).toMatchObject({ id: 'cv1' });
  });
});

describe('GET /sms-inbox/threads/:id/messages', () => {
  it('lists messages and marks the thread read', async () => {
    a.sms.listMessages.mockResolvedValue({ messages: [{ id: 'm1' }], total: 1 });
    const res = await request(app()).get('/sms-inbox/threads/cv1/messages');
    expect(res.status).toBe(200);
    expect(a.sms.markConversationRead).toHaveBeenCalledWith('t1', 'cv1');
  });
});

describe('PATCH /sms-inbox/threads/:id', () => {
  it('rejects an invalid status', async () => {
    const res = await request(app()).patch('/sms-inbox/threads/cv1').send({ status: 'weird' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Validation failed', fields: { status: 'Invalid status' } });
  });
  it('rejects an invalid followUpAt date', async () => {
    const res = await request(app()).patch('/sms-inbox/threads/cv1').send({ followUpAt: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.fields.followUpAt).toBeTruthy();
  });
  it('rejects unknown fields so they never reach the database', async () => {
    const res = await request(app()).patch('/sms-inbox/threads/cv1').send({ status: 'closed', sneaky: true });
    expect(res.status).toBe(400);
    expect(a.sms.updateConversation).not.toHaveBeenCalled();
  });
  it('404 when the conversation is missing', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    expect((await request(app()).patch('/sms-inbox/threads/cv1').send({ status: 'closed' })).status).toBe(404);
  });
  it('returns 404 and does not update tenant B thread ids', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    const res = await request(app()).patch('/sms-inbox/threads/tenant-b-cv').send({ status: 'closed' });
    expect(res.status).toBe(404);
    expect(a.sms.updateConversation).not.toHaveBeenCalled();
  });
  it('updates the conversation + logs activity + audit', async () => {
    a.sms.getConversation.mockResolvedValue({ id: 'cv1', status: 'open', assigneeUserId: null });
    const res = await request(app()).patch('/sms-inbox/threads/cv1').send({ status: 'closed' });
    expect(res.status).toBe(200);
    expect(a.sms.logActivity).toHaveBeenCalledWith(
      't1',
      'cv1',
      'status_changed',
      'u1',
      'e@x.com',
      expect.objectContaining({ from: 'open', to: 'closed' }),
    );
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'sms_conversation.updated' }));
  });
  it('logs assignment when assigneeUserId changes', async () => {
    a.sms.getConversation.mockResolvedValue({ ...ownThread, assigneeUserId: null });
    const res = await request(app()).patch('/sms-inbox/threads/cv1').send({ assigneeUserId: 'u2' });
    expect(res.status).toBe(200);
    expect(a.sms.logActivity).toHaveBeenCalledWith(
      't1',
      'cv1',
      'assigned',
      'u1',
      'e@x.com',
      expect.objectContaining({ to: 'u2' }),
    );
  });
  it('logs status_changed on reopen', async () => {
    a.sms.getConversation.mockResolvedValue({ ...ownThread, status: 'closed' });
    const res = await request(app()).patch('/sms-inbox/threads/cv1').send({ status: 'open' });
    expect(res.status).toBe(200);
    expect(a.sms.logActivity).toHaveBeenCalledWith(
      't1',
      'cv1',
      'status_changed',
      'u1',
      'e@x.com',
      expect.objectContaining({ from: 'closed', to: 'open' }),
    );
  });
});

describe('PUT /sms-inbox/threads/:id', () => {
  it('uses the same schema as PATCH', async () => {
    a.sms.getConversation.mockResolvedValue({ ...ownThread });
    const res = await request(app()).put('/sms-inbox/threads/cv1').send({ status: 'pending' });
    expect(res.status).toBe(200);
    expect(a.sms.updateConversation).toHaveBeenCalled();
  });
});

describe('POST /sms-inbox/threads/:id/messages', () => {
  it('requires a body', async () => {
    const res = await request(app()).post('/sms-inbox/threads/cv1/messages').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Validation failed', fields: { body: 'body is required' } });
  });
  it('rejects a body over 640 characters', async () => {
    const res = await request(app()).post('/sms-inbox/threads/cv1/messages').send({ body: 'x'.repeat(641) });
    expect(res.status).toBe(400);
    expect(res.body.fields.body).toBeTruthy();
    expect(a.sendUserSms).not.toHaveBeenCalled();
  });
  it('404 when the conversation is missing', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    expect((await request(app()).post('/sms-inbox/threads/cv1/messages').send({ body: 'hi' })).status).toBe(404);
  });
  it('returns 404 and does not send for tenant B thread ids', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    const res = await request(app()).post('/sms-inbox/threads/tenant-b-cv').send({ body: 'hi' });
    expect(res.status).toBe(404);
    expect(a.sendUserSms).not.toHaveBeenCalled();
  });
  it('rejects an empty Idempotency-Key header', async () => {
    const res = await request(app())
      .post('/sms-inbox/threads/cv1/messages')
      .set('Idempotency-Key', '   ')
      .send({ body: 'Thanks' });
    expect(res.status).toBe(400);
    expect(res.body.fields['idempotency-key']).toBeTruthy();
    expect(a.sendUserSms).not.toHaveBeenCalled();
  });
  it('passes a namespaced Idempotency-Key into sendUserSms', async () => {
    a.sms.getConversation.mockResolvedValue(ownThread);
    a.poolQueryMock.mockResolvedValue({ rows: [{ phone_number: '+15555550100' }] });
    const res = await request(app())
      .post('/sms-inbox/threads/cv1/messages')
      .set('Idempotency-Key', 'reply-1')
      .send({ body: 'Thanks' });
    expect(res.status).toBe(200);
    expect(a.sendUserSms).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: smsInboxReplyIdempotencyKey('t1', 'cv1', 'reply-1'),
        body: 'Thanks',
        to: '+15555550142',
        purpose: 'conversational',
      }),
    );
  });
  it('returns the chokepoint reason and does not send when the recipient opted out', async () => {
    a.sms.getConversation.mockResolvedValue(ownThread);
    a.poolQueryMock.mockResolvedValue({ rows: [{ phone_number: '+15555550100' }] });
    a.sendUserSms.mockResolvedValue({
      ok: false,
      error: { code: 'RECIPIENT_OPTED_OUT', message: 'Recipient has opted out of SMS' },
    });
    const res = await request(app()).post('/sms-inbox/threads/cv1/messages').send({ body: 'Hi' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Recipient has opted out of SMS',
      reason: 'recipient_opted_out',
      code: 'RECIPIENT_OPTED_OUT',
    });
    expect(a.sms.logActivity).not.toHaveBeenCalled();
  });
});

describe('POST /sms-inbox/threads/:id/notes', () => {
  it('rejects a missing body with fields', async () => {
    const res = await request(app()).post('/sms-inbox/threads/cv1/notes').send({});
    expect(res.status).toBe(400);
    expect(res.body.fields.body).toBeTruthy();
    expect(a.sms.addInternalNote).not.toHaveBeenCalled();
  });
  it('returns 404 and does not insert a note on tenant B thread ids', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    const res = await request(app()).post('/sms-inbox/threads/tenant-b-cv/notes').send({ body: 'secret' });
    expect(res.status).toBe(404);
    expect(a.sms.addInternalNote).not.toHaveBeenCalled();
  });
  it('adds a note and writes an activity row', async () => {
    a.sms.getConversation.mockResolvedValue(ownThread);
    const res = await request(app()).post('/sms-inbox/threads/cv1/notes').send({ body: 'Called back' });
    expect(res.status).toBe(201);
    expect(a.sms.addInternalNote).toHaveBeenCalledWith('t1', 'cv1', 'u1', 'e@x.com', 'Called back');
    expect(a.sms.logActivity).toHaveBeenCalledWith('t1', 'cv1', 'note_added', 'u1', 'e@x.com');
  });
});

describe('POST /sms-inbox/bulk-update', () => {
  it('rejects more than 200 ids', async () => {
    const res = await request(app())
      .post('/sms-inbox/bulk-update')
      .send({ conversationIds: Array.from({ length: SMS_INBOX_BULK_ID_LIMIT + 1 }, (_, i) => `cv-${i}`), status: 'closed' });
    expect(res.status).toBe(400);
    expect(res.body.fields.conversationIds).toMatch(/at most 200/);
    expect(a.sms.bulkUpdateConversations).not.toHaveBeenCalled();
  });
  it('returns 400 with fields when conversationIds is missing', async () => {
    const res = await request(app()).post('/sms-inbox/bulk-update').send({ status: 'closed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });
  it('changes only own rows when the id list mixes own and foreign threads', async () => {
    a.sms.getConversation.mockImplementation(async (_tenant: string, id: string) => {
      if (id === 'cv-own-1' || id === 'cv-own-2') return { ...ownThread, id };
      return null;
    });
    const res = await request(app())
      .post('/sms-inbox/bulk-update')
      .send({ conversationIds: ['cv-own-1', 'tenant-b-cv', 'cv-own-2'], status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(a.sms.bulkUpdateConversations).toHaveBeenCalledWith('t1', ['cv-own-1', 'cv-own-2'], expect.objectContaining({ status: 'closed' }));
    const activityIds = a.sms.logActivity.mock.calls.map((c: unknown[]) => c[1]);
    expect(activityIds).toEqual(['cv-own-1', 'cv-own-2']);
    expect(a.sms.logActivity).toHaveBeenCalledWith(
      't1',
      'cv-own-1',
      'status_changed',
      'u1',
      'e@x.com',
      expect.objectContaining({ bulk: true, to: 'closed' }),
    );
  });
  it('returns updated: 0 and writes no activity when every id is foreign', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    const res = await request(app())
      .post('/sms-inbox/bulk-update')
      .send({ conversationIds: ['tenant-b-cv'], status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    expect(a.sms.bulkUpdateConversations).not.toHaveBeenCalled();
    expect(a.sms.logActivity).not.toHaveBeenCalled();
  });
});

describe('templates', () => {
  it('rejects a create without title/body', async () => {
    const res = await request(app()).post('/sms-inbox/templates').send({ title: '' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toBeTruthy();
    expect(a.sms.createCannedResponse).not.toHaveBeenCalled();
  });
  it('returns 404 and does not update a tenant B template id', async () => {
    a.sms.updateCannedResponse.mockResolvedValue(null);
    const res = await request(app()).patch('/sms-inbox/templates/tenant-b-tpl').send({ title: 'Hi' });
    expect(res.status).toBe(404);
    expect(a.sms.updateCannedResponse).toHaveBeenCalledWith('t1', 'tenant-b-tpl', expect.objectContaining({ title: 'Hi' }));
  });
  it('returns 404 and does not delete a tenant B template id', async () => {
    a.sms.deleteCannedResponse.mockResolvedValue(false);
    const res = await request(app()).delete('/sms-inbox/templates/tenant-b-tpl');
    expect(res.status).toBe(404);
  });
});

describe('auto-reply and assignment rules', () => {
  it('rejects an auto-reply create without name/replyBody', async () => {
    const res = await request(app()).post('/sms-inbox/auto-reply-rules').send({ name: 'Hours' });
    expect(res.status).toBe(400);
    expect(res.body.fields.replyBody).toBeTruthy();
    expect(a.sms.createAutoReplyRule).not.toHaveBeenCalled();
  });
  it('returns 404 and does not update a tenant B auto-reply rule id', async () => {
    a.sms.updateAutoReplyRule.mockResolvedValue(null);
    const res = await request(app()).patch('/sms-inbox/auto-reply-rules/tenant-b-ar').send({ name: 'Nope' });
    expect(res.status).toBe(404);
  });
  it('returns 404 and does not delete a tenant B assignment rule id', async () => {
    a.sms.deleteAssignmentRule.mockResolvedValue(false);
    const res = await request(app()).delete('/sms-inbox/assignment-rules/tenant-b-as');
    expect(res.status).toBe(404);
    expect(a.sms.deleteAssignmentRule).toHaveBeenCalledWith('t1', 'tenant-b-as');
  });
  it('rejects an assignment rule without matchField', async () => {
    const res = await request(app()).post('/sms-inbox/assignment-rules').send({ name: 'VIP', matchValue: 'urgent' });
    expect(res.status).toBe(400);
    expect(a.sms.createAssignmentRule).not.toHaveBeenCalled();
  });
});
