// Fixture day: Thursday 2026-10-15 in America/New_York (EDT, UTC-4), so the
// day is [2026-10-15T04:00:00Z, 2026-10-16T04:00:00Z).
//
//   CA_A  DB + Twilio, 180 s, Twilio $0.02550, xAI 180 audio s @ $0.08/min
//   CA_B  DB + Twilio, 240 s, Twilio $0.03400, recording RE_B $0.0100, xAI cost given
//   CA_C  DB + Twilio,  60 s, Twilio $0.00850, transfer leg CA_C_LEG $0.01400, NO xAI usage
//   CA_D  DB + Twilio,  30 s, starts 23:59:59 local (03:59:59Z next UTC day), xAI 30 s
//   XU_ORPHAN  xAI usage for CA_UNKNOWN (no such call), $0.05 → unattributed
//   CA_E  starts 00:00:00 local on the 16th → next day, ignored with its xAI row
//   CA_F  starts 23:30 local on the 14th (03:30Z on the 15th) → previous day,
//         ignored with its recording RE_F

import type { DbCallRow, TwilioCallRow, TwilioRecordingRow, XaiUsageRow } from '../types';

export const FIXTURE_DATE = '2026-10-15';

export const fixtureTwilioCalls: TwilioCallRow[] = [
  { callSid: 'CA_A', parentCallSid: null, startTime: '2026-10-15T14:00:00.000Z', durationSeconds: 180, priceMicros: 25_500, priceUnit: 'USD', status: 'completed' },
  { callSid: 'CA_B', parentCallSid: null, startTime: '2026-10-15T15:30:00.000Z', durationSeconds: 240, priceMicros: 34_000, priceUnit: 'USD', status: 'completed' },
  { callSid: 'CA_C', parentCallSid: null, startTime: '2026-10-15T20:00:00.000Z', durationSeconds: 60, priceMicros: 8_500, priceUnit: 'USD', status: 'completed' },
  { callSid: 'CA_C_LEG', parentCallSid: 'CA_C', startTime: '2026-10-15T20:00:15.000Z', durationSeconds: 45, priceMicros: 14_000, priceUnit: 'USD', status: 'completed' },
  { callSid: 'CA_D', parentCallSid: null, startTime: '2026-10-16T03:59:59.000Z', durationSeconds: 30, priceMicros: 8_500, priceUnit: 'USD', status: 'completed' },
  { callSid: 'CA_E', parentCallSid: null, startTime: '2026-10-16T04:00:00.000Z', durationSeconds: 120, priceMicros: 17_000, priceUnit: 'USD', status: 'completed' },
  { callSid: 'CA_F', parentCallSid: null, startTime: '2026-10-15T03:30:00.000Z', durationSeconds: 120, priceMicros: 17_000, priceUnit: 'USD', status: 'completed' },
];

export const fixtureTwilioRecordings: TwilioRecordingRow[] = [
  { recordingSid: 'RE_B', callSid: 'CA_B', createdAt: '2026-10-15T15:34:01.000Z', durationSeconds: 240, priceMicros: 10_000, priceUnit: 'USD' },
  { recordingSid: 'RE_F', callSid: 'CA_F', createdAt: '2026-10-15T03:32:01.000Z', durationSeconds: 120, priceMicros: 5_000, priceUnit: 'USD' },
];

export const fixtureXaiUsage: XaiUsageRow[] = [
  { usageId: 'XU_A', callSid: 'CA_A', occurredAt: '2026-10-15T14:03:00.000Z', model: 'grok-voice-3.0', audioSeconds: 180, costMicros: null },
  { usageId: 'XU_B', callSid: 'CA_B', occurredAt: '2026-10-15T15:34:00.000Z', model: 'grok-voice-3.0', audioSeconds: 240, costMicros: 312_345 },
  { usageId: 'XU_D', callSid: 'CA_D', occurredAt: '2026-10-16T04:00:29.000Z', model: 'grok-voice-3.0', audioSeconds: 30, costMicros: null },
  { usageId: 'XU_E', callSid: 'CA_E', occurredAt: '2026-10-16T04:02:00.000Z', model: 'grok-voice-3.0', audioSeconds: 120, costMicros: null },
  { usageId: 'XU_ORPHAN', callSid: 'CA_UNKNOWN', occurredAt: '2026-10-15T18:00:00.000Z', model: 'grok-voice-3.0', audioSeconds: null, costMicros: 50_000 },
];

export const fixtureDbCalls: DbCallRow[] = [
  { callSid: 'CA_A', callSessionId: 'cs-a', tenantId: 'shop-1', startedAt: '2026-10-15T14:00:00.000Z', durationSeconds: 180, estimate: { xaiCents: 12, twilioMicros: 25_500 } },
  { callSid: 'CA_B', callSessionId: 'cs-b', tenantId: 'shop-1', startedAt: '2026-10-15T15:30:00.000Z', durationSeconds: 240, estimate: { xaiCents: 20, twilioMicros: 34_000 } },
  { callSid: 'CA_C', callSessionId: 'cs-c', tenantId: 'shop-2', startedAt: '2026-10-15T20:00:00.000Z', durationSeconds: 60, estimate: null },
  { callSid: 'CA_D', callSessionId: 'cs-d', tenantId: 'shop-2', startedAt: '2026-10-16T03:59:59.000Z', durationSeconds: 30, estimate: { xaiCents: 2, twilioMicros: null } },
  { callSid: 'CA_E', callSessionId: 'cs-e', tenantId: 'shop-2', startedAt: '2026-10-16T04:00:00.000Z', durationSeconds: 120, estimate: null },
  { callSid: 'CA_F', callSessionId: 'cs-f', tenantId: 'shop-1', startedAt: '2026-10-15T03:30:00.000Z', durationSeconds: 120, estimate: null },
];

export const fixtureInput = {
  date: FIXTURE_DATE,
  xaiUsage: fixtureXaiUsage,
  twilioCalls: fixtureTwilioCalls,
  twilioRecordings: fixtureTwilioRecordings,
  dbCalls: fixtureDbCalls,
};
