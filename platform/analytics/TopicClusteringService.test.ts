import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<unknown>) => cb(),
}));
vi.mock('../core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { classifyCallTopic, getTopicDistribution, getTopicTrends } from './TopicClusteringService';

const transcript = [
  { role: 'assistant', content: 'How can I help?' },
  { role: 'user', content: 'I want to reschedule my appointment.' },
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

describe('classifyCallTopic', () => {
  it('returns null without an API key', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await classifyCallTopic('t1', 'cs1', transcript)).toBeNull();
  });
  it('returns null for a too-short transcript', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(await classifyCallTopic('t1', 'cs1', [{ role: 'user', content: 'hi' }])).toBeNull();
  });
  it('classifies a known topic and persists', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ primary_topic: 'scheduling', secondary_topics: ['follow_up', 'bogus'], confidence: 0.9, reasoning: 'r' }) } }] }),
    }));
    a.clientQueryMock.mockResolvedValue({ rows: [{ id: 'tc1', tenant_id: 't1', call_session_id: 'cs1', primary_topic: 'scheduling', secondary_topics: ['follow_up'], confidence: 0.9, classified_at: '2026-01-01T00:00:00Z' }] });
    const res = await classifyCallTopic('t1', 'cs1', transcript);
    expect(res).toMatchObject({ id: 'tc1', primaryTopic: 'scheduling' });
    // The INSERT should have filtered the unknown secondary topic out.
    const insert = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO call_topic_classifications'));
    expect(insert?.[1]?.[3]).toEqual(['follow_up']);
  });
  it('falls back to "other" for an unknown primary topic', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ primary_topic: 'made_up', confidence: 0.5 }) } }] }),
    }));
    a.clientQueryMock.mockResolvedValue({ rows: [{ id: 'tc2', tenant_id: 't1', call_session_id: 'cs1', primary_topic: 'other', secondary_topics: [], confidence: 0.5, classified_at: '2026-01-01T00:00:00Z' }] });
    await classifyCallTopic('t1', 'cs1', transcript);
    const insert = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO call_topic_classifications'));
    expect(insert?.[1]?.[2]).toBe('other');
  });
  it('returns null on a non-ok API response', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await classifyCallTopic('t1', 'cs1', transcript)).toBeNull();
  });
});

describe('getTopicDistribution', () => {
  it('maps counts and derives percentages', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ topic: 'scheduling', count: 6 }, { topic: 'billing_inquiry', count: 2 }] });
    const res = await getTopicDistribution('t1', FROM, TO);
    expect(res[0]).toMatchObject({ topic: 'scheduling', count: 6, percentage: 0.75 });
  });
  it('returns [] on error', async () => {
    a.clientQueryMock.mockRejectedValue(new Error('boom'));
    expect(await getTopicDistribution('t1', FROM, TO)).toEqual([]);
  });
});

describe('getTopicTrends', () => {
  it('maps per-day topic counts', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ date: '2026-01-02', topic: 'scheduling', count: 3 }] });
    expect((await getTopicTrends('t1', FROM, TO))[0]).toMatchObject({ date: '2026-01-02', topic: 'scheduling', count: 3 });
  });
  it('returns [] on error', async () => {
    a.clientQueryMock.mockRejectedValue(new Error('boom'));
    expect(await getTopicTrends('t1', FROM, TO)).toEqual([]);
  });
});
