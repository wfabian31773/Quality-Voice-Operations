import { describe, expect, it } from 'vitest';

import { dayWindow } from './dayWindow';
import {
  DB_CALLS_SQL,
  createDbCallSource,
  createTwilioSource,
  createXaiUsageApiSource,
  createXaiUsageFileSource,
  mapTwilioCall,
  mapTwilioRecording,
  parseXaiUsageRows,
} from './sources';

// Fixture-only: every fetch / query below is a stub. No network, no DB.

const window = dayWindow('2026-10-15');

describe('Twilio adapter', () => {
  it('maps a Call resource (RFC 2822 time, negative price string)', () => {
    expect(mapTwilioCall({
      sid: 'CA1', parent_call_sid: null, start_time: 'Thu, 15 Oct 2026 14:00:00 +0000',
      duration: '180', price: '-0.02550', price_unit: 'USD', status: 'completed',
    })).toEqual({
      callSid: 'CA1', parentCallSid: null, startTime: '2026-10-15T14:00:00.000Z',
      durationSeconds: 180, priceMicros: 25_500, priceUnit: 'USD', status: 'completed',
    });
    expect(mapTwilioCall({ sid: 'CA2', start_time: null })).toBeNull();
    expect(mapTwilioCall({ sid: 'CA3', start_time: 'Thu, 15 Oct 2026 14:00:00 +0000', price: null })?.priceMicros).toBeNull();
  });

  it('maps a Recording resource', () => {
    expect(mapTwilioRecording({
      sid: 'RE1', call_sid: 'CA1', date_created: 'Thu, 15 Oct 2026 14:03:00 +0000',
      duration: '180', price: '-0.0075', price_unit: 'USD',
    })).toEqual({
      recordingSid: 'RE1', callSid: 'CA1', createdAt: '2026-10-15T14:03:00.000Z',
      durationSeconds: 180, priceMicros: 7_500, priceUnit: 'USD',
    });
  });

  it('follows next_page_uri, filters by padded UTC dates, and sends basic auth', async () => {
    const urls: string[] = [];
    const auths: string[] = [];
    const pages: Record<string, unknown> = {
      first: { calls: [{ sid: 'CA1', start_time: 'Thu, 15 Oct 2026 14:00:00 +0000', duration: '1', price: '-0.0085', price_unit: 'USD' }], next_page_uri: '/next' },
      next: { calls: [{ sid: 'CA2', start_time: 'Thu, 15 Oct 2026 15:00:00 +0000', duration: '2', price: null }], next_page_uri: null },
    };
    const source = createTwilioSource({
      accountSid: 'ACtest',
      authToken: 'tok',
      baseUrl: 'https://twilio.invalid',
      fetchImpl: async (url, init) => {
        urls.push(url);
        auths.push(init.headers.Authorization);
        return { ok: true, status: 200, json: async () => (url.endsWith('/next') ? pages.next : pages.first) };
      },
    });
    const calls = await source.fetchCalls(window);
    expect(calls.map((c) => c.callSid)).toEqual(['CA1', 'CA2']);
    const first = new URL(urls[0]);
    expect(first.pathname).toBe('/2010-04-01/Accounts/ACtest/Calls.json');
    expect(first.searchParams.get('StartTime>')).toBe('2026-10-14');
    expect(first.searchParams.get('StartTime<')).toBe('2026-10-17');
    expect(urls[1]).toBe('https://twilio.invalid/next');
    expect(auths[0]).toBe(`Basic ${Buffer.from('ACtest:tok').toString('base64')}`);
  });

  it('fails with the HTTP status only, never the credentials', async () => {
    const source = createTwilioSource({
      accountSid: 'ACsecret', authToken: 'supersecret', baseUrl: 'https://twilio.invalid',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    const err = await source.fetchRecordings(window).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error('expected fetchRecordings to reject with an Error');
    expect(err.message).toBe('Twilio recordings list failed with HTTP 401');
    expect(err.message).not.toContain('supersecret');
  });
});

describe('DB adapter', () => {
  it('queries call_sessions joined to conversation_costs and maps estimates', async () => {
    const seen: unknown[][] = [];
    const source = createDbCallSource(async (sql, values) => {
      expect(sql).toBe(DB_CALLS_SQL);
      seen.push(values);
      return {
        rows: [
          { call_sid: 'CA1', call_session_id: 's1', tenant_id: 't', started_at: '2026-10-15T14:00:00.000Z', duration_seconds: 180, has_cost_row: true, llm_cost_cents: 12, twilio_price_cents: '2.5500' },
          { call_sid: 'CA2', call_session_id: 's2', tenant_id: 't', started_at: '2026-10-15T15:00:00.000Z', duration_seconds: null, has_cost_row: false, llm_cost_cents: null, twilio_price_cents: null },
          { call_sid: null, call_session_id: 's3', tenant_id: 't', started_at: '2026-10-15T15:00:00.000Z' },
        ],
      };
    });
    const rows = await source.fetchCalls(window);
    expect(seen[0]).toEqual(['2026-10-15 03:00:00.000', '2026-10-16 05:00:00.000']);
    expect(rows).toEqual([
      { callSid: 'CA1', callSessionId: 's1', tenantId: 't', startedAt: '2026-10-15T14:00:00.000Z', durationSeconds: 180, estimate: { xaiCents: 12, twilioMicros: 25_500 } },
      { callSid: 'CA2', callSessionId: 's2', tenantId: 't', startedAt: '2026-10-15T15:00:00.000Z', durationSeconds: null, estimate: null },
    ]);
  });
});

describe('xAI usage adapters', () => {
  it('reads normalized rows from a file', async () => {
    const source = createXaiUsageFileSource('usage.json', async () => JSON.stringify([
      { usageId: 'u1', callSid: 'CA1', occurredAt: '2026-10-15T14:03:00Z', model: 'grok-voice-3.0', audioSeconds: 180, costMicros: null, inputTokens: 10 },
    ]));
    expect(await source.fetchUsage(window)).toEqual([
      { usageId: 'u1', callSid: 'CA1', occurredAt: '2026-10-15T14:03:00.000Z', model: 'grok-voice-3.0', audioSeconds: 180, costMicros: null, inputTokens: 10 },
    ]);
  });

  it('rejects malformed rows', () => {
    expect(() => parseXaiUsageRows({})).toThrow('JSON array');
    expect(() => parseXaiUsageRows([{ usageId: 'u', model: 'm' }])).toThrow('occurredAt');
    expect(() => parseXaiUsageRows([{ usageId: 'u', model: 'm', occurredAt: '2026-10-15T00:00:00Z', costMicros: 1.5 }])).toThrow('costMicros');
  });

  it('API adapter is an explicit TODO, not an invented endpoint', async () => {
    await expect(createXaiUsageApiSource().fetchUsage(window)).rejects.toThrow('not implemented');
  });
});
