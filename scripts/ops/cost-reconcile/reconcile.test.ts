import { describe, expect, it } from 'vitest';

import {
  fixtureInput,
  fixtureMidnightRecordings,
  fixtureMidnightTwilioCalls,
  fixtureMidnightXaiUsage,
} from './__fixtures__/fixtureDay';
import { reconcileDay, xaiUsageMicros } from './reconcile';
import type { ReconcileInput } from './types';

// Hand-computed expectations for the fixture day (see __fixtures__/fixtureDay.ts).
// micro-USD; 10_000 micros = 1 cent; cents rounded half-up once.
//   A  xAI 180 s × 80_000/60 = 240_000  + Twilio 25_500                 = 265_500 → 27¢, 8.85¢/min
//   B  xAI 312_345 (given)   + Twilio 34_000 + recording 10_000          = 356_345 → 36¢, 8.91¢/min
//   C  no xAI                + Twilio 8_500 + leg 14_000                 =  22_500 →  2¢, 2.25¢/min
//   D  xAI 30 s → 40_000     + Twilio 8_500                              =  48_500 →  5¢, 9.70¢/min
//   orphan xAI 50_000 (unattributed)
//   day: attributed 692_845 + unattributed 50_000 = 742_845 → 74¢ over 510 s → 8.74¢/min

describe('reconcileDay — fixture day', () => {
  const report = reconcileDay(fixtureInput);
  const bySid = Object.fromEntries(report.calls.map((c) => [c.callSid, c]));

  it('uses the America/New_York day as an explicit UTC window', () => {
    expect(report.timeZone).toBe('America/New_York');
    expect(report.window).toEqual({ startUtc: '2026-10-15T04:00:00.000Z', endUtc: '2026-10-16T04:00:00.000Z' });
  });

  it('keeps exactly the calls that started on the local day', () => {
    expect(report.calls.map((c) => c.callSid)).toEqual(['CA_A', 'CA_B', 'CA_C', 'CA_D']);
    expect(report.outOfWindowIgnored).toEqual({ xaiUsage: 1, twilioCalls: 2, recordings: 1, dbCalls: 2 });
  });

  it('costs each call to hand-computed cents', () => {
    expect(bySid.CA_A).toMatchObject({
      durationSeconds: 180, minutes: 3, xaiCents: 24, twilioVoiceCents: 3, recordingCents: 0, totalCents: 27, centsPerMinute: 8.85,
      micros: { xai: 240_000, twilioVoice: 25_500, recording: 0, total: 265_500 },
    });
    expect(bySid.CA_B).toMatchObject({
      durationSeconds: 240, xaiCents: 31, twilioVoiceCents: 3, recordingCents: 1, totalCents: 36, centsPerMinute: 8.91,
      micros: { xai: 312_345, twilioVoice: 34_000, recording: 10_000, total: 356_345 },
      recordingSids: ['RE_B'],
    });
    expect(bySid.CA_C).toMatchObject({
      durationSeconds: 60, xaiCents: 0, twilioVoiceCents: 2, totalCents: 2, centsPerMinute: 2.25,
      micros: { xai: 0, twilioVoice: 22_500, recording: 0, total: 22_500 },
      twilioChildLegSids: ['CA_C_LEG'],
    });
    expect(bySid.CA_D).toMatchObject({
      durationSeconds: 30, xaiCents: 4, twilioVoiceCents: 1, totalCents: 5, centsPerMinute: 9.7,
      micros: { total: 48_500 },
    });
  });

  it('puts the recording fee on the call that was recorded, and only there', () => {
    expect(report.calls.filter((c) => c.recordingCents > 0).map((c) => c.callSid)).toEqual(['CA_B']);
    expect(report.totals.micros.recording).toBe(10_000);
    expect(report.unmatched.recordingsWithoutCall).toEqual([]);
  });

  it('totals the day in micros and rounds once', () => {
    expect(report.totals).toEqual({
      calls: 4,
      durationSeconds: 510,
      minutes: 8.5,
      xaiCents: 64,
      twilioVoiceCents: 9,
      recordingCents: 1,
      attributedCents: 69,
      unattributedCents: 5,
      totalCents: 74,
      centsPerMinute: 8.74,
      micros: { xai: 642_345, twilioVoice: 90_500, recording: 10_000, attributed: 692_845, unattributed: 50_000, total: 742_845 },
    });
  });

  it('lists unmatched rows on both sides instead of dropping them', () => {
    expect(report.unmatched).toEqual({
      xaiUsageWithoutCall: [
        { usageId: 'XU_ORPHAN', callSid: 'CA_UNKNOWN', occurredAt: '2026-10-15T18:00:00.000Z', reason: 'unknown_call', costCents: 5 },
      ],
      callsWithoutXaiUsage: ['CA_C'],
      twilioCallsWithoutDbCall: [],
      dbCallsWithoutTwilioCall: [],
      recordingsWithoutCall: [],
      twilioChildLegsWithoutCall: [],
    });
    expect(report.complete).toBe(true);
  });

  it('reports estimate vs reconciled over the calls that have an estimate', () => {
    // A 145_500, B 234_000, D 20_000 → 399_500 estimated; reconciled 670_345.
    expect(report.estimate).toEqual({
      callsCompared: 3,
      estimateCents: 40,
      reconciledCents: 67,
      deltaCents: 27,
      deltaPct: 67.8,
    });
    expect(bySid.CA_A).toMatchObject({ estimateCents: 15, deltaCents: 12 });
    expect(bySid.CA_C).toMatchObject({ estimateCents: null, deltaCents: null });
  });
});

describe('reconcileDay — a call that spans midnight is costed once', () => {
  // CA_D starts 23:59:59 on the 15th; XU_D (00:00:29) and the midnight rows
  // (CA_D_LEG, RE_D, RE_D_LEG) all land after midnight. XU_STRAY names no call.
  const withMidnight: ReconcileInput = {
    ...fixtureInput,
    xaiUsage: [...fixtureInput.xaiUsage, ...fixtureMidnightXaiUsage],
    twilioCalls: [...fixtureInput.twilioCalls, ...fixtureMidnightTwilioCalls],
    twilioRecordings: [...fixtureInput.twilioRecordings, ...fixtureMidnightRecordings],
  };
  const day15 = reconcileDay(withMidnight);
  const day16 = reconcileDay({ ...withMidnight, date: '2026-10-16' });

  it('does not charge XU_D again on the 16th as unknown_call', () => {
    const report = reconcileDay({ ...fixtureInput, date: '2026-10-16' });
    expect(report.calls.map((c) => c.callSid)).toEqual(['CA_E']);
    expect(report.unmatched.xaiUsageWithoutCall).toEqual([]);
    expect(report.totals.micros).toMatchObject({ unattributed: 0, total: 177_000 });
    expect(report.outOfWindowIgnored).toEqual({ xaiUsage: 4, twilioCalls: 6, recordings: 2, dbCalls: 5 });
  });

  it('counts the post-midnight leg and recordings on the start day', () => {
    expect(day15.calls.find((c) => c.callSid === 'CA_D')).toMatchObject({
      twilioChildLegSids: ['CA_D_LEG'],
      recordingSids: ['RE_D', 'RE_D_LEG'],
      xaiUsageIds: ['XU_D'],
      micros: { xai: 40_000, twilioVoice: 12_500, recording: 4_000, total: 56_500 },
    });
    expect(day15.outOfWindowIgnored).toEqual({ xaiUsage: 2, twilioCalls: 2, recordings: 1, dbCalls: 2 });
  });

  it('ignores them on the next day instead of listing them as unattributed', () => {
    expect(day16.calls.map((c) => c.callSid)).toEqual(['CA_E']);
    expect(day16.unmatched.twilioChildLegsWithoutCall).toEqual([]);
    expect(day16.unmatched.recordingsWithoutCall).toEqual([]);
    expect(day16.unmatched.xaiUsageWithoutCall.map((u) => u.usageId)).not.toContain('XU_D');
    expect(day16.outOfWindowIgnored).toEqual({ xaiUsage: 4, twilioCalls: 7, recordings: 4, dbCalls: 5 });
  });

  it('still lists a next-day row naming a truly unknown call as unattributed', () => {
    expect(day16.unmatched.xaiUsageWithoutCall).toEqual([
      { usageId: 'XU_STRAY', callSid: 'CA_NOWHERE', occurredAt: '2026-10-16T05:00:00.000Z', reason: 'unknown_call', costCents: 1 },
    ]);
    expect(day16.totals.micros).toMatchObject({ attributed: 177_000, unattributed: 7_000, total: 184_000 });
  });

  it('sums two consecutive days to each row costed exactly once', () => {
    // Every priced row except CA_F and RE_F, which belong to the 14th.
    const previousDay = new Set(['CA_F', 'RE_F']);
    const twilio = withMidnight.twilioCalls.filter((c) => !previousDay.has(c.callSid)).map((c) => c.priceMicros ?? 0);
    const recordings = withMidnight.twilioRecordings.filter((r) => !previousDay.has(r.recordingSid)).map((r) => r.priceMicros ?? 0);
    const xai = withMidnight.xaiUsage.map((u) => xaiUsageMicros(u) ?? 0);
    const everyRowOnce = [...twilio, ...recordings, ...xai].reduce((sum, m) => sum + m, 0);
    expect(everyRowOnce).toBe(934_845);
    expect(day15.totals.micros.total + day16.totals.micros.total).toBe(everyRowOnce);

    const sids15 = day15.calls.map((c) => c.callSid);
    const sids16 = day16.calls.map((c) => c.callSid);
    expect(sids15.filter((sid) => sids16.includes(sid))).toEqual([]);
  });
});

describe('reconcileDay — edge cases', () => {
  const base: ReconcileInput = { date: '2026-10-15', xaiUsage: [], twilioCalls: [], twilioRecordings: [], dbCalls: [] };

  it('keeps a Twilio call we have no DB row for, and a DB call Twilio does not list', () => {
    const report = reconcileDay({
      ...base,
      twilioCalls: [{ callSid: 'CA_T', parentCallSid: null, startTime: '2026-10-15T12:00:00Z', durationSeconds: 60, priceMicros: 8_500, priceUnit: 'USD', status: 'completed' }],
      dbCalls: [{ callSid: 'CA_DB', callSessionId: 's', tenantId: 't', startedAt: '2026-10-15T13:00:00Z', durationSeconds: 42, estimate: null }],
    });
    expect(report.unmatched.twilioCallsWithoutDbCall).toEqual(['CA_T']);
    expect(report.unmatched.dbCallsWithoutTwilioCall).toEqual(['CA_DB']);
    expect(report.calls.find((c) => c.callSid === 'CA_DB')).toMatchObject({ durationSeconds: 42, durationSource: 'db' });
    expect(report.totals.micros.twilioVoice).toBe(8_500);
  });

  it('marks the day incomplete while Twilio has not priced a call or recording yet', () => {
    const report = reconcileDay({
      ...base,
      twilioCalls: [{ callSid: 'CA_P', parentCallSid: null, startTime: '2026-10-15T12:00:00Z', durationSeconds: 60, priceMicros: null, priceUnit: null, status: 'completed' }],
      twilioRecordings: [{ recordingSid: 'RE_P', callSid: 'CA_P', createdAt: '2026-10-15T12:01:00Z', durationSeconds: 60, priceMicros: null, priceUnit: null }],
    });
    expect(report.complete).toBe(false);
    expect(report.incomplete.twilioPricePending).toEqual(['CA_P']);
    expect(report.incomplete.recordingPricePending).toEqual(['RE_P']);
    expect(report.calls[0].recordingSids).toEqual(['RE_P']);
  });

  it('does not add non-USD prices into USD totals', () => {
    const report = reconcileDay({
      ...base,
      twilioCalls: [{ callSid: 'CA_EUR', parentCallSid: null, startTime: '2026-10-15T12:00:00Z', durationSeconds: 60, priceMicros: 9_000, priceUnit: 'EUR', status: 'completed' }],
    });
    expect(report.incomplete.nonUsd).toEqual(['CA_EUR']);
    expect(report.totals.micros.total).toBe(0);
    expect(report.complete).toBe(false);
  });

  it('attributes a recording made on a transfer leg to the parent call', () => {
    const report = reconcileDay({
      ...base,
      twilioCalls: [
        { callSid: 'CA_P', parentCallSid: null, startTime: '2026-10-15T12:00:00Z', durationSeconds: 60, priceMicros: 0, priceUnit: 'USD', status: 'completed' },
        { callSid: 'CA_LEG', parentCallSid: 'CA_P', startTime: '2026-10-15T12:00:10Z', durationSeconds: 50, priceMicros: 0, priceUnit: 'USD', status: 'completed' },
      ],
      twilioRecordings: [{ recordingSid: 'RE_LEG', callSid: 'CA_LEG', createdAt: '2026-10-15T12:01:00Z', durationSeconds: 50, priceMicros: 2_500, priceUnit: 'USD' }],
    });
    expect(report.calls[0]).toMatchObject({ callSid: 'CA_P', recordingSids: ['RE_LEG'], micros: { recording: 2_500 } });
  });

  it('lists in-day recordings and legs whose call is unknown as unattributed cost', () => {
    const report = reconcileDay({
      ...base,
      twilioCalls: [{ callSid: 'CA_LEG', parentCallSid: 'CA_GONE', startTime: '2026-10-15T12:00:10Z', durationSeconds: 50, priceMicros: 7_000, priceUnit: 'USD', status: 'completed' }],
      twilioRecordings: [{ recordingSid: 'RE_X', callSid: 'CA_NOPE', createdAt: '2026-10-15T12:01:00Z', durationSeconds: 50, priceMicros: 2_500, priceUnit: 'USD' }],
    });
    expect(report.unmatched.twilioChildLegsWithoutCall).toEqual([{ callSid: 'CA_LEG', parentCallSid: 'CA_GONE', startTime: '2026-10-15T12:00:10Z', costCents: 1 }]);
    expect(report.unmatched.recordingsWithoutCall).toEqual([{ recordingSid: 'RE_X', callSid: 'CA_NOPE', createdAt: '2026-10-15T12:01:00Z', costCents: 0 }]);
    expect(report.totals.micros.unattributed).toBe(9_500);
    expect(report.totals.unattributedCents).toBe(1);
  });

  it('reports xAI usage with no call key, and unpriced models, without guessing', () => {
    const report = reconcileDay({
      ...base,
      xaiUsage: [
        { usageId: 'XU_AGG', callSid: null, occurredAt: '2026-10-15T23:00:00Z', model: 'grok-voice-3.0', audioSeconds: 60, costMicros: null },
        { usageId: 'XU_NEW', callSid: null, occurredAt: '2026-10-15T23:00:00Z', model: 'grok-voice-9', audioSeconds: 60, costMicros: null },
      ],
    });
    expect(report.unmatched.xaiUsageWithoutCall.map((u) => [u.usageId, u.reason, u.costCents])).toEqual([
      ['XU_AGG', 'no_call_key', 8],
      ['XU_NEW', 'no_call_key', 0],
    ]);
    expect(report.incomplete.xaiUnpriced).toEqual(['XU_NEW']);
  });

  it('prices xAI seconds at the RT-03 pinned $0.08/min only when no cost is given', () => {
    expect(xaiUsageMicros({ usageId: 'x', callSid: null, occurredAt: '', model: 'grok-voice-3.0', audioSeconds: 20, costMicros: null })).toBe(26_667);
    expect(xaiUsageMicros({ usageId: 'x', callSid: null, occurredAt: '', model: 'grok-voice-3.0', audioSeconds: 20, costMicros: 1 })).toBe(1);
  });

  it('has no float drift summing many sub-cent prices', () => {
    const twilioCalls = Array.from({ length: 1000 }, (_, i) => ({
      callSid: `CA_${i}`, parentCallSid: null, startTime: '2026-10-15T12:00:00Z', durationSeconds: 1, priceMicros: 1_700, priceUnit: 'USD', status: 'completed',
    }));
    const report = reconcileDay({ ...base, twilioCalls });
    expect(report.totals.micros.twilioVoice).toBe(1_700_000);
    expect(report.totals.twilioVoiceCents).toBe(170);
  });
});
