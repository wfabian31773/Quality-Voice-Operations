// Pure core of the daily cost reconciler (RT-05). No I/O: takes already-
// fetched xAI usage, Twilio call and recording rows, and our call rows,
// and returns the reconciliation report for one America/New_York day.
//
// Attribution, in order:
//   1. The day's calls are Twilio parent calls and our DB calls, joined on
//      CallSid. A call belongs to the day by its start time (our DB start
//      time when we have the row, else Twilio's), inside [00:00, 24:00) local.
//   2. Twilio child legs (Dial / transfer) carry `parentCallSid`; their price
//      goes to the parent call's Twilio voice cost.
//   3. A recording goes to the call its `callSid` names, or to that leg's
//      parent when the recording was made on a child leg.
//   4. An xAI usage row goes to the call its `callSid` names.
// A row that names a known call (a root seen in Twilio or the DB) that
// started outside the day, or a child leg of one, is only counted under
// `outOfWindowIgnored`, whatever its own timestamp: it is costed on that
// call's start day. Both fetchers over-fetch by a day or more, so the root
// of a call that spans midnight is seen on both days. Any other row that
// reaches no in-day call is listed under `unmatched` (and its cost counted
// as unattributed) when its own timestamp is inside the day, and only
// counted under `outOfWindowIgnored` when it is not. A call that spans
// midnight is therefore costed once, on the day it started.

import { dayWindow, isInWindow } from './dayWindow';
import {
  MICROS_PER_CENT,
  centsPerMinute,
  microsToCents,
  percentOf,
  roundDiv,
  secondsToMinutes,
  sumMicros,
} from './money';
import type {
  CallCost,
  DbCallRow,
  ReconcileInput,
  ReconciliationReport,
  TwilioCallRow,
  UnmatchedChildLeg,
  UnmatchedRecording,
  UnmatchedXaiUsage,
  XaiUsageRow,
} from './types';

/**
 * xAI voice list price in micro-USD per minute, used only when a usage row
 * reports seconds but no cost. Mirrors the RT-03 (#118) pin in
 * platform/billing/cost/providerRates.ts: grok-voice-3.0 is priced the same
 * as 2.0, $0.08/min. A model missing here is reported as unpriced rather
 * than guessed.
 */
export const XAI_MICROS_PER_MINUTE: Readonly<Record<string, number>> = {
  'grok-voice-3.0': 80_000,
  'grok-voice-think-fast-2.0': 80_000,
};

interface CallAccumulator {
  callSid: string;
  db: DbCallRow | null;
  twilio: TwilioCallRow | null;
  startedAt: string;
  xaiMicros: number[];
  twilioMicros: number[];
  recordingMicros: number[];
  childLegSids: string[];
  recordingSids: string[];
  xaiUsageIds: string[];
}

export function xaiUsageMicros(row: XaiUsageRow): number | null {
  if (row.costMicros !== null) {
    if (!Number.isSafeInteger(row.costMicros) || row.costMicros < 0) {
      throw new Error(`xAI usage ${row.usageId} has an invalid cost`);
    }
    return row.costMicros;
  }
  const rate = XAI_MICROS_PER_MINUTE[row.model];
  if (row.audioSeconds === null || rate === undefined) return null;
  if (!Number.isSafeInteger(row.audioSeconds) || row.audioSeconds < 0) {
    throw new Error(`xAI usage ${row.usageId} has invalid audio seconds`);
  }
  return roundDiv(row.audioSeconds * rate, 60);
}

function estimateMicrosOf(db: DbCallRow | null): number | null {
  if (!db?.estimate) return null;
  return db.estimate.xaiCents * MICROS_PER_CENT + (db.estimate.twilioMicros ?? 0);
}

function firstBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    if (!map.has(k)) map.set(k, row);
  }
  return map;
}

export function reconcileDay(input: ReconcileInput): ReconciliationReport {
  const window = dayWindow(input.date);

  const incomplete: ReconciliationReport['incomplete'] = {
    twilioPricePending: [],
    recordingPricePending: [],
    xaiUnpriced: [],
    nonUsd: [],
  };
  const outOfWindowIgnored = { xaiUsage: 0, twilioCalls: 0, recordings: 0, dbCalls: 0 };

  // A Twilio/recording price only counts when it is present and in USD.
  const usdMicros = (
    priceMicros: number | null,
    priceUnit: string | null,
    id: string,
    pending: string[],
  ): number => {
    if (priceMicros === null) {
      pending.push(id);
      return 0;
    }
    if (priceUnit !== null && priceUnit.toUpperCase() !== 'USD') {
      incomplete.nonUsd.push(id);
      return 0;
    }
    if (!Number.isSafeInteger(priceMicros) || priceMicros < 0) {
      throw new Error(`${id} has an invalid price`);
    }
    return priceMicros;
  };

  const dbBySid = firstBy(input.dbCalls, (row) => row.callSid);
  const twilioRoots = input.twilioCalls.filter((row) => row.parentCallSid === null);
  const twilioChildren = input.twilioCalls.filter((row) => row.parentCallSid !== null);
  const twilioRootBySid = firstBy(twilioRoots, (row) => row.callSid);

  // 1. The day's calls.
  const calls = new Map<string, CallAccumulator>();
  // Known calls that started on another day; rows naming them are theirs.
  const outOfWindowRoots = new Set<string>();
  const candidateSids = new Set<string>([...dbBySid.keys(), ...twilioRootBySid.keys()]);
  for (const sid of candidateSids) {
    const db = dbBySid.get(sid) ?? null;
    const twilio = twilioRootBySid.get(sid) ?? null;
    const startedAt = db?.startedAt ?? twilio?.startTime ?? '';
    if (!isInWindow(startedAt, window)) {
      if (db) outOfWindowIgnored.dbCalls += 1;
      if (twilio) outOfWindowIgnored.twilioCalls += 1;
      outOfWindowRoots.add(sid);
      continue;
    }
    const acc: CallAccumulator = {
      callSid: sid,
      db,
      twilio,
      startedAt,
      xaiMicros: [],
      twilioMicros: [],
      recordingMicros: [],
      childLegSids: [],
      recordingSids: [],
      xaiUsageIds: [],
    };
    if (twilio) acc.twilioMicros.push(usdMicros(twilio.priceMicros, twilio.priceUnit, sid, incomplete.twilioPricePending));
    calls.set(sid, acc);
  }

  // 2. Twilio child legs → parent call.
  const childToParent = new Map<string, string>();
  const outOfWindowLegs = new Set<string>();
  const unmatchedChildLegs: UnmatchedChildLeg[] = [];
  let unmatchedChildMicros = 0;
  for (const leg of twilioChildren) {
    const parentSid = leg.parentCallSid as string;
    const parent = calls.get(parentSid);
    if (parent) {
      childToParent.set(leg.callSid, parentSid);
      parent.childLegSids.push(leg.callSid);
      parent.twilioMicros.push(usdMicros(leg.priceMicros, leg.priceUnit, leg.callSid, incomplete.twilioPricePending));
    } else if (outOfWindowRoots.has(parentSid)) {
      outOfWindowLegs.add(leg.callSid);
      outOfWindowIgnored.twilioCalls += 1;
    } else if (isInWindow(leg.startTime, window)) {
      const micros = usdMicros(leg.priceMicros, leg.priceUnit, leg.callSid, incomplete.twilioPricePending);
      unmatchedChildMicros += micros;
      unmatchedChildLegs.push({
        callSid: leg.callSid,
        parentCallSid: parentSid,
        startTime: leg.startTime,
        costCents: microsToCents(micros),
      });
    } else {
      outOfWindowIgnored.twilioCalls += 1;
    }
  }

  // 3. Recordings → their call, or the parent of the leg they were made on.
  const unmatchedRecordings: UnmatchedRecording[] = [];
  let unmatchedRecordingMicros = 0;
  for (const rec of input.twilioRecordings) {
    const owner = calls.get(rec.callSid) ?? calls.get(childToParent.get(rec.callSid) ?? '');
    if (owner) {
      owner.recordingSids.push(rec.recordingSid);
      owner.recordingMicros.push(usdMicros(rec.priceMicros, rec.priceUnit, rec.recordingSid, incomplete.recordingPricePending));
    } else if (outOfWindowRoots.has(rec.callSid) || outOfWindowLegs.has(rec.callSid)) {
      outOfWindowIgnored.recordings += 1;
    } else if (isInWindow(rec.createdAt, window)) {
      const micros = usdMicros(rec.priceMicros, rec.priceUnit, rec.recordingSid, incomplete.recordingPricePending);
      unmatchedRecordingMicros += micros;
      unmatchedRecordings.push({
        recordingSid: rec.recordingSid,
        callSid: rec.callSid,
        createdAt: rec.createdAt,
        costCents: microsToCents(micros),
      });
    } else {
      outOfWindowIgnored.recordings += 1;
    }
  }

  // 4. xAI usage → call by CallSid.
  const unmatchedXai: UnmatchedXaiUsage[] = [];
  let unmatchedXaiMicros = 0;
  for (const usage of input.xaiUsage) {
    const owner = usage.callSid === null ? undefined : calls.get(usage.callSid);
    const otherDayCall = usage.callSid !== null && outOfWindowRoots.has(usage.callSid);
    if (!owner && (otherDayCall || !isInWindow(usage.occurredAt, window))) {
      outOfWindowIgnored.xaiUsage += 1;
      continue;
    }
    const priced = xaiUsageMicros(usage);
    if (priced === null) incomplete.xaiUnpriced.push(usage.usageId);
    const micros = priced ?? 0;
    if (owner) {
      owner.xaiUsageIds.push(usage.usageId);
      owner.xaiMicros.push(micros);
    } else {
      unmatchedXaiMicros += micros;
      unmatchedXai.push({
        usageId: usage.usageId,
        callSid: usage.callSid,
        occurredAt: usage.occurredAt,
        reason: usage.callSid === null ? 'no_call_key' : 'unknown_call',
        costCents: microsToCents(micros),
      });
    }
  }

  // Per-call rows.
  const callCosts: CallCost[] = [...calls.values()]
    .sort((a, b) => (a.startedAt === b.startedAt ? a.callSid.localeCompare(b.callSid) : Date.parse(a.startedAt) - Date.parse(b.startedAt)))
    .map((acc) => {
      const xai = sumMicros(acc.xaiMicros);
      const twilioVoice = sumMicros(acc.twilioMicros);
      const recording = sumMicros(acc.recordingMicros);
      const total = sumMicros([xai, twilioVoice, recording]);
      const durationSource: CallCost['durationSource'] = acc.twilio ? 'twilio' : acc.db?.durationSeconds != null ? 'db' : 'none';
      const durationSeconds = acc.twilio?.durationSeconds ?? acc.db?.durationSeconds ?? 0;
      const estimateMicros = estimateMicrosOf(acc.db);
      return {
        callSid: acc.callSid,
        callSessionId: acc.db?.callSessionId ?? null,
        tenantId: acc.db?.tenantId ?? null,
        startedAt: acc.startedAt,
        durationSeconds,
        durationSource,
        minutes: secondsToMinutes(durationSeconds),
        xaiCents: microsToCents(xai),
        twilioVoiceCents: microsToCents(twilioVoice),
        recordingCents: microsToCents(recording),
        totalCents: microsToCents(total),
        centsPerMinute: centsPerMinute(total, durationSeconds),
        micros: { xai, twilioVoice, recording, total },
        sources: { db: acc.db !== null, twilio: acc.twilio !== null, xai: acc.xaiUsageIds.length > 0 },
        twilioChildLegSids: [...acc.childLegSids].sort(),
        recordingSids: [...acc.recordingSids].sort(),
        xaiUsageIds: [...acc.xaiUsageIds].sort(),
        estimateCents: estimateMicros === null ? null : microsToCents(estimateMicros),
        deltaCents: estimateMicros === null ? null : microsToCents(total - estimateMicros),
      };
    });

  // Day totals, summed in micros and rounded once.
  const attributed = sumMicros(callCosts.map((c) => c.micros.total));
  const unattributed = sumMicros([unmatchedXaiMicros, unmatchedRecordingMicros, unmatchedChildMicros]);
  const total = sumMicros([attributed, unattributed]);
  const xaiTotal = sumMicros([...callCosts.map((c) => c.micros.xai), unmatchedXaiMicros]);
  const twilioTotal = sumMicros([...callCosts.map((c) => c.micros.twilioVoice), unmatchedChildMicros]);
  const recordingTotal = sumMicros([...callCosts.map((c) => c.micros.recording), unmatchedRecordingMicros]);
  const durationSeconds = callCosts.reduce((sum, c) => sum + c.durationSeconds, 0);

  // Estimate vs reconciled, over the calls that have an estimate.
  const estimated = [...calls.values()].flatMap((acc) => {
    const micros = estimateMicrosOf(acc.db);
    return micros === null ? [] : [{ callSid: acc.callSid, micros }];
  });
  let estimate: ReconciliationReport['estimate'] = null;
  if (estimated.length > 0) {
    const estimateMicros = sumMicros(estimated.map((e) => e.micros));
    const estimatedSids = new Set(estimated.map((e) => e.callSid));
    const reconciledMicros = sumMicros(callCosts.filter((c) => estimatedSids.has(c.callSid)).map((c) => c.micros.total));
    const deltaMicros = reconciledMicros - estimateMicros;
    estimate = {
      callsCompared: estimated.length,
      estimateCents: microsToCents(estimateMicros),
      reconciledCents: microsToCents(reconciledMicros),
      deltaCents: microsToCents(deltaMicros),
      deltaPct: percentOf(deltaMicros, estimateMicros),
    };
  }

  const sortedIncomplete = {
    twilioPricePending: [...incomplete.twilioPricePending].sort(),
    recordingPricePending: [...incomplete.recordingPricePending].sort(),
    xaiUnpriced: [...incomplete.xaiUnpriced].sort(),
    nonUsd: [...incomplete.nonUsd].sort(),
  };

  return {
    date: window.date,
    timeZone: window.timeZone,
    window: { startUtc: window.startUtc, endUtc: window.endUtc },
    complete: Object.values(sortedIncomplete).every((list) => list.length === 0),
    calls: callCosts,
    totals: {
      calls: callCosts.length,
      durationSeconds,
      minutes: secondsToMinutes(durationSeconds),
      xaiCents: microsToCents(xaiTotal),
      twilioVoiceCents: microsToCents(twilioTotal),
      recordingCents: microsToCents(recordingTotal),
      attributedCents: microsToCents(attributed),
      unattributedCents: microsToCents(unattributed),
      totalCents: microsToCents(total),
      centsPerMinute: centsPerMinute(total, durationSeconds),
      micros: {
        xai: xaiTotal,
        twilioVoice: twilioTotal,
        recording: recordingTotal,
        attributed,
        unattributed,
        total,
      },
    },
    estimate,
    unmatched: {
      xaiUsageWithoutCall: unmatchedXai.sort((a, b) => a.usageId.localeCompare(b.usageId)),
      callsWithoutXaiUsage: callCosts.filter((c) => !c.sources.xai).map((c) => c.callSid),
      twilioCallsWithoutDbCall: callCosts.filter((c) => c.sources.twilio && !c.sources.db).map((c) => c.callSid),
      dbCallsWithoutTwilioCall: callCosts.filter((c) => c.sources.db && !c.sources.twilio).map((c) => c.callSid),
      recordingsWithoutCall: unmatchedRecordings.sort((a, b) => a.recordingSid.localeCompare(b.recordingSid)),
      twilioChildLegsWithoutCall: unmatchedChildLegs.sort((a, b) => a.callSid.localeCompare(b.callSid)),
    },
    incomplete: sortedIncomplete,
    outOfWindowIgnored,
  };
}
