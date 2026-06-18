import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  existsMock: vi.fn(),
  downloadMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../replit_integrations/object_storage', () => ({
  objectStorageClient: {
    bucket: () => ({ file: () => ({ exists: a.existsMock, download: a.downloadMock, save: a.saveMock }) }),
  },
}));

import router, { SUPPORTED_VOICES } from './voicePreview';

const VOICE = [...SUPPORTED_VOICES][0];

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const fetchMock = vi.fn();

// Unique greeting per test keeps the module-level LRU cache from colliding
// across cases (except where a test deliberately re-requests the same input).
let n = 0;
const uniqueGreeting = () => `Hello there number ${n++}`;

beforeEach(() => {
  a.user.userId = `u-${Math.random().toString(36).slice(2)}`; // unique rate-limit key per test
  a.existsMock.mockReset().mockResolvedValue([false]);
  a.downloadMock.mockReset();
  a.saveMock.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.OPENAI_API_KEY = 'sk-test';
  delete process.env.PRIVATE_OBJECT_DIR;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

describe('POST /agents/voice-preview validation', () => {
  it('rejects an unsupported voice', async () => {
    const res = await request(app()).post('/agents/voice-preview').send({ voice: 'nope', language: 'en' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('voice');
  });

  it('rejects an unsupported language', async () => {
    const res = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'xx' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('language');
  });
});

describe('POST /agents/voice-preview synthesis', () => {
  it('returns 503 when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting: uniqueGreeting() });
    expect(res.status).toBe(503);
  });

  it('synthesizes via OpenAI on a cache miss and returns mp3', async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('AUDIO').buffer });
    const res = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting: uniqueGreeting() });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.headers['x-voice-preview-cache']).toBe('miss');
  });

  it('serves a hot cache hit on the second identical request', async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('AUDIO').buffer });
    const greeting = uniqueGreeting();
    await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting });
    const res2 = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting });
    expect(res2.headers['x-voice-preview-cache']).toBe('hit');
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
  });

  it('serves the warm tier from object storage when present', async () => {
    process.env.PRIVATE_OBJECT_DIR = '/bucket/private';
    a.existsMock.mockResolvedValue([true]);
    a.downloadMock.mockResolvedValue([Buffer.from('STORED')]);
    const res = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting: uniqueGreeting() });
    expect(res.status).toBe(200);
    expect(res.headers['x-voice-preview-cache']).toBe('warm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an upstream auth failure to 503', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const res = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting: uniqueGreeting() });
    expect(res.status).toBe(503);
  });

  it('maps other upstream failures to 502', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' });
    const res = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting: uniqueGreeting() });
    expect(res.status).toBe(502);
  });

  it('returns 502 when the fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const res = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting: uniqueGreeting() });
    expect(res.status).toBe(502);
  });

  it('rate-limits a burst from the same tenant:user with 429', async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('A').buffer });
    a.user.userId = 'fixed-user';
    let last = 200;
    for (let i = 0; i < 33; i++) {
      const res = await request(app()).post('/agents/voice-preview').send({ voice: VOICE, language: 'en', greeting: `burst ${i}` });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
