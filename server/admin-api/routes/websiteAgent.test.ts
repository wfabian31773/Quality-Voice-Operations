import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  chatMock: vi.fn(),
  getGreetingMock: vi.fn(),
  getLeadsMock: vi.fn(),
  getAnalyticsSummaryMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/website-agent/WebsiteSalesAgentService', () => ({
  chat: a.chatMock,
  getGreeting: a.getGreetingMock,
  getLeads: a.getLeadsMock,
  getAnalyticsSummary: a.getAnalyticsSummaryMock,
}));

import websiteAgentRouter from './websiteAgent';

function app() {
  const app = express();
  app.use(express.json());
  app.use(websiteAgentRouter);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = false;
  a.chatMock.mockReset().mockResolvedValue({ reply: 'hello there' });
  a.getGreetingMock.mockReset().mockReturnValue('Hi, how can I help?');
  a.getLeadsMock.mockReset().mockResolvedValue({ leads: [], total: 0 });
  a.getAnalyticsSummaryMock.mockReset().mockResolvedValue({ conversations: 0 });
});

describe('POST /website-agent/chat (public)', () => {
  it('rejects an empty message', async () => {
    expect((await request(app()).post('/website-agent/chat').send({ message: '   ' })).status).toBe(400);
  });

  it('rejects an over-long message', async () => {
    expect((await request(app()).post('/website-agent/chat').send({ message: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('sanitizes ids and returns the chat result', async () => {
    const res = await request(app())
      .post('/website-agent/chat')
      .send({ message: '  hi  ', conversationId: 'abc!!##def', sourcePage: '/pricing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: 'hello there' });
    const [cid, msg, page] = a.chatMock.mock.calls[0];
    expect(cid).toBe('abcdef'); // illegal chars stripped
    expect(msg).toBe('hi'); // trimmed
    expect(page).toBe('/pricing');
  });

  it('returns 500 when the agent throws', async () => {
    a.chatMock.mockRejectedValue(new Error('llm down'));
    expect((await request(app()).post('/website-agent/chat').send({ message: 'hi' })).status).toBe(500);
  });
});

describe('GET /website-agent/greeting (public)', () => {
  it('returns the greeting for the requested page', async () => {
    a.getGreetingMock.mockReturnValue('Welcome!');
    const res = await request(app()).get('/website-agent/greeting?page=/demo');
    expect(res.body).toEqual({ greeting: 'Welcome!', page: '/demo' });
    expect(a.getGreetingMock).toHaveBeenCalledWith('/demo');
  });
});

describe('GET /website-agent/leads & /analytics (platform admin)', () => {
  it('lists leads for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    a.getLeadsMock.mockResolvedValue({ leads: [{ id: 'l1' }], total: 1 });
    const res = await request(app()).get('/website-agent/leads?status=new&limit=10');
    expect(res.status).toBe(200);
    expect(a.getLeadsMock).toHaveBeenCalledWith('new', 10, 0);
  });

  it('rejects a non-platform-admin from leads with 403', async () => {
    expect((await request(app()).get('/website-agent/leads')).status).toBe(403);
  });

  it('returns analytics for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    a.getAnalyticsSummaryMock.mockResolvedValue({ conversations: 5 });
    expect((await request(app()).get('/website-agent/analytics')).body).toEqual({ conversations: 5 });
  });

  it('returns 500 when analytics fails', async () => {
    a.user.isPlatformAdmin = true;
    a.getAnalyticsSummaryMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/website-agent/analytics')).status).toBe(500);
  });

  // Runs last: exhausts the module-level per-IP chat rate-limit counter.
  it('rate-limits a chat burst from the same ip with 429', async () => {
    let last = 200;
    for (let i = 0; i < 35; i++) {
      const res = await request(app()).post('/website-agent/chat').send({ message: 'hi' });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
