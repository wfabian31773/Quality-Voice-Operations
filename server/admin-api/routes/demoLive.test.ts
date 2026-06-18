import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.queryMock }) }));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import router from './demoLive';

function app() {
  const app = express();
  app.use(router);
  return app;
}

beforeEach(() => {
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
});

// Note: the SSE happy path of /demo/live/:callId opens a long-lived
// text/event-stream (setInterval poll + heartbeat) that never completes a
// supertest request, so we only exercise the pre-stream validation guards.
describe('GET /demo/live/:callId guards', () => {
  it('rejects an over-long call id with 400', async () => {
    const res = await request(app()).get(`/demo/live/${'x'.repeat(101)}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the demo call session does not exist', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    const res = await request(app()).get('/demo/live/call-1');
    expect(res.status).toBe(404);
  });

  it('returns 500 when the session lookup throws', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    const res = await request(app()).get('/demo/live/call-1');
    expect(res.status).toBe(500);
  });
});

describe('GET /demo/active-call', () => {
  it('returns mapped active demo calls', async () => {
    a.queryMock.mockResolvedValue({
      rows: [
        { id: 'c1', lifecycle_state: 'ACTIVE_CONVERSATION', caller_number: '+1', agent_id: 'a1', agent_name: 'Bot', start_time: 'now' },
      ],
    });
    const res = await request(app()).get('/demo/active-call');
    expect(res.status).toBe(200);
    expect(res.body.activeCalls).toEqual([
      { callId: 'c1', state: 'ACTIVE_CONVERSATION', agentName: 'Bot', startTime: 'now' },
    ]);
  });

  it('returns 500 on query failure', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/demo/active-call')).status).toBe(500);
  });
});
