import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<unknown>) => cb(),
}));
vi.mock('../core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import {
  QUALITY_SCORING_RUBRIC, scoreCall, getCallQualityScore, getQualityAnalytics, getLowestScoringCalls,
} from './QualityScorerService';

const transcript = [
  { role: 'assistant', content: 'Hello, how can I help?' },
  { role: 'user', content: 'I need to reschedule.' },
];

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

describe('QUALITY_SCORING_RUBRIC', () => {
  it('is a non-empty prompt', () => {
    expect(QUALITY_SCORING_RUBRIC.length).toBeGreaterThan(0);
  });
});

describe('scoreCall', () => {
  it('returns null when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await scoreCall('t1', 'cs1', transcript)).toBeNull();
  });
  it('returns null for a too-short transcript', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(await scoreCall('t1', 'cs1', [{ role: 'user', content: 'hi' }])).toBeNull();
  });
  it('scores and persists when the API responds', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const feedback = { overall_score: 8, summary: 'good' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(feedback) } }] }),
    }));
    a.clientQueryMock.mockResolvedValue({ rows: [{ id: 'q1', tenant_id: 't1', call_session_id: 'cs1', score: 8, feedback, scored_by: 'gpt-4o-mini', scored_at: '2026-01-01T00:00:00Z' }] });
    const res = await scoreCall('t1', 'cs1', transcript);
    expect(res).toMatchObject({ id: 'q1', score: 8 });
    const insert = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO call_quality_scores'));
    expect(insert).toBeTruthy();
  });
  it('returns null when the API responds non-ok', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await scoreCall('t1', 'cs1', transcript)).toBeNull();
  });
  it('returns null when fetch throws', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await scoreCall('t1', 'cs1', transcript)).toBeNull();
  });
});

describe('getCallQualityScore', () => {
  it('maps the latest score row', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ id: 'q1', tenant_id: 't1', call_session_id: 'cs1', score: 7, feedback: {}, scored_by: 'gpt-4o-mini', scored_at: '2026-01-01T00:00:00Z' }] });
    expect((await getCallQualityScore('t1', 'cs1'))?.score).toBe(7);
  });
  it('returns null when there is no score', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [] });
    expect(await getCallQualityScore('t1', 'cs1')).toBeNull();
  });
});

describe('getQualityAnalytics', () => {
  it('maps the per-day/agent trend rows', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ date: '2026-01-02', avg_score: '8.5', call_count: 3, agent_id: 'ag1', agent_name: 'Bot' }] });
    const res = await getQualityAnalytics('t1', 30);
    expect(res[0]).toMatchObject({ date: '2026-01-02', avgScore: 8.5, callCount: 3, agentId: 'ag1' });
  });
  it('returns [] on a query error', async () => {
    a.clientQueryMock.mockRejectedValue(new Error('boom'));
    expect(await getQualityAnalytics('t1')).toEqual([]);
  });
});

describe('getLowestScoringCalls', () => {
  it('maps rows and pulls summary out of feedback', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ call_session_id: 'cs1', score: 2, feedback: { summary: 'rough call' }, scored_at: '2026-01-01T00:00:00Z', agent_name: 'Bot', agent_id: 'ag1', duration_seconds: 90, transcript_preview: 'assistant: hi' }] });
    const res = await getLowestScoringCalls('t1', 10);
    expect(res[0]).toMatchObject({ callSessionId: 'cs1', score: 2, summary: 'rough call', transcriptPreview: 'assistant: hi' });
  });
  it('returns [] on a query error', async () => {
    a.clientQueryMock.mockRejectedValue(new Error('boom'));
    expect(await getLowestScoringCalls('t1')).toEqual([]);
  });
});
