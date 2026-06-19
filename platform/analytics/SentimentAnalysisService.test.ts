import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<unknown>) => cb(),
}));
vi.mock('../core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { analyzeCallSentiment, getSentimentTrends, getAgentSentiments } from './SentimentAnalysisService';

const transcript = [
  { role: 'assistant', content: 'Hi there!' },
  { role: 'user', content: 'Thanks, that was great.' },
];
const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-02-01T00:00:00Z');

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.OPENAI_API_KEY;
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe('analyzeCallSentiment', () => {
  it('returns null without an API key', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await analyzeCallSentiment('t1', 'cs1', transcript)).toBeNull();
  });
  it('returns null for a too-short transcript', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(await analyzeCallSentiment('t1', 'cs1', [{ role: 'user', content: 'hi' }])).toBeNull();
  });
  it('analyzes and persists when the API responds', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ sentiment_score: 0.8, sentiment_label: 'positive', confidence: 0.9, key_emotions: ['happy'], summary: 'good' }) } }] }),
    }));
    a.clientQueryMock.mockResolvedValue({ rows: [{ id: 's1', tenant_id: 't1', call_session_id: 'cs1', sentiment_score: 0.8, sentiment_label: 'positive', confidence: 0.9, details: {}, scored_at: '2026-01-01T00:00:00Z' }] });
    const res = await analyzeCallSentiment('t1', 'cs1', transcript);
    expect(res).toMatchObject({ id: 's1', sentimentLabel: 'positive', sentimentScore: 0.8 });
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO call_sentiment_scores'))).toBe(true);
  });
  it('returns null on a non-ok API response', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect(await analyzeCallSentiment('t1', 'cs1', transcript)).toBeNull();
  });
  it('returns null when fetch throws', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await analyzeCallSentiment('t1', 'cs1', transcript)).toBeNull();
  });
});

describe('getSentimentTrends', () => {
  it('maps daily sentiment rows', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ date: '2026-01-02', avg_score: '0.5', call_count: 4, positive_count: 3, neutral_count: 1, negative_count: 0 }] });
    const res = await getSentimentTrends('t1', FROM, TO);
    expect(res[0]).toMatchObject({ date: '2026-01-02', avgScore: 0.5, callCount: 4, positiveCount: 3 });
  });
  it('returns [] on error', async () => {
    a.clientQueryMock.mockRejectedValue(new Error('boom'));
    expect(await getSentimentTrends('t1', FROM, TO)).toEqual([]);
  });
});

describe('getAgentSentiments', () => {
  it('maps per-agent sentiment and derives positive rate', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ agent_id: 'ag1', agent_name: 'Bot', avg_score: '0.6', call_count: 10, positive_count: 6 }] });
    const res = await getAgentSentiments('t1', FROM, TO);
    expect(res[0]).toMatchObject({ agentId: 'ag1', avgScore: 0.6, callCount: 10, positiveRate: 0.6 });
  });
  it('returns [] on error', async () => {
    a.clientQueryMock.mockRejectedValue(new Error('boom'));
    expect(await getAgentSentiments('t1', FROM, TO)).toEqual([]);
  });
});
