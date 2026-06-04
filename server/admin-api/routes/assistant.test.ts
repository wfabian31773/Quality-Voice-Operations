import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  chatMock: vi.fn(),
  getSessionsMock: vi.fn(),
  getAnalyticsMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/assistant/PlatformAssistantService', () => ({
  chat: a.chatMock,
  getSessions: a.getSessionsMock,
  getAnalytics: a.getAnalyticsMock,
}));

import assistantRouter from './assistant';

function app() {
  const app = express();
  app.use(express.json());
  app.use(assistantRouter);
  return app;
}

beforeEach(() => {
  a.chatMock.mockReset().mockResolvedValue({ reply: 'hi', sessionId: 's1' });
  a.getSessionsMock.mockReset().mockResolvedValue({ sessions: [], total: 0 });
  a.getAnalyticsMock.mockReset().mockResolvedValue({ messages: 0 });
});

describe('POST /assistant/chat', () => {
  it('rejects an empty message', async () => {
    expect((await request(app()).post('/assistant/chat').send({ message: '   ' })).status).toBe(400);
  });

  it('rejects an over-long message', async () => {
    const res = await request(app()).post('/assistant/chat').send({ message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('returns the chat result and forwards trimmed input', async () => {
    const res = await request(app()).post('/assistant/chat').send({ message: '  hello  ', sessionId: 's1', pageContext: '/calls' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: 'hi', sessionId: 's1' });
    expect(a.chatMock).toHaveBeenCalledWith('t1', 'u1', 'operations_manager', 's1', 'hello', '/calls');
  });

  it('returns 500 when the assistant fails', async () => {
    a.chatMock.mockRejectedValue(new Error('llm down'));
    expect((await request(app()).post('/assistant/chat').send({ message: 'hi' })).status).toBe(500);
  });
});

describe('GET /assistant/sessions', () => {
  it('returns paged sessions', async () => {
    a.getSessionsMock.mockResolvedValue({ sessions: [{ id: 's1' }], total: 1 });
    const res = await request(app()).get('/assistant/sessions?limit=10&page=2');
    expect(res.status).toBe(200);
    expect(a.getSessionsMock).toHaveBeenCalledWith('t1', 'u1', 10, 10);
  });

  it('returns 500 on failure', async () => {
    a.getSessionsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/assistant/sessions')).status).toBe(500);
  });
});

describe('GET /assistant/analytics', () => {
  it('returns analytics', async () => {
    a.getAnalyticsMock.mockResolvedValue({ messages: 42 });
    const res = await request(app()).get('/assistant/analytics');
    expect(res.body).toEqual({ messages: 42 });
  });

  it('returns 500 on failure', async () => {
    a.getAnalyticsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/assistant/analytics')).status).toBe(500);
  });
});
