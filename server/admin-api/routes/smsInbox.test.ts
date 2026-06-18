import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  poolQueryMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
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

import router from './smsInbox';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  a.sms.listConversations = vi.fn().mockResolvedValue({ conversations: [], total: 0 });
  a.sms.getConversation = vi.fn();
  a.sms.updateConversation = vi.fn().mockResolvedValue({ id: 'cv1' });
  a.sms.listMessages = vi.fn().mockResolvedValue({ messages: [], total: 0 });
  a.sms.markConversationRead = vi.fn().mockResolvedValue(undefined);
  a.sms.logActivity = vi.fn().mockResolvedValue(undefined);
});

describe('GET /sms-inbox/conversations (phone lines)', () => {
  it('lists phone lines from the DB', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 'pn1', phone_number: '+15551230000', friendly_name: 'Main' }] });
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
    expect((await request(app()).patch('/sms-inbox/threads/cv1').send({ status: 'weird' })).status).toBe(400);
  });
  it('rejects an invalid followUpAt date', async () => {
    expect((await request(app()).patch('/sms-inbox/threads/cv1').send({ followUpAt: 'not-a-date' })).status).toBe(400);
  });
  it('404 when the conversation is missing', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    expect((await request(app()).patch('/sms-inbox/threads/cv1').send({ status: 'closed' })).status).toBe(404);
  });
  it('updates the conversation + logs activity + audit', async () => {
    a.sms.getConversation.mockResolvedValue({ id: 'cv1', status: 'open', assigneeUserId: null });
    const res = await request(app()).patch('/sms-inbox/threads/cv1').send({ status: 'closed' });
    expect(res.status).toBe(200);
    expect(a.sms.logActivity).toHaveBeenCalled();
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'sms_conversation.updated' }));
  });
});

describe('POST /sms-inbox/threads/:id/messages', () => {
  it('requires a body', async () => {
    expect((await request(app()).post('/sms-inbox/threads/cv1/messages').send({})).status).toBe(400);
  });
  it('404 when the conversation is missing', async () => {
    a.sms.getConversation.mockResolvedValue(null);
    expect((await request(app()).post('/sms-inbox/threads/cv1/messages').send({ body: 'hi' })).status).toBe(404);
  });
});
