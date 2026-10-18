// Input records (already fetched and normalized by the adapters) and the
// reconciliation report. Money is integer micro-USD on input; the report
// carries both micros and cents.

/** One xAI usage record, normalized by an XaiUsageSource adapter. */
export interface XaiUsageRow {
  /** Stable id of the usage record (from xAI, or synthesized by the adapter). */
  usageId: string;
  /** Twilio CallSid this usage belongs to; null when the record carries no call key. */
  callSid: string | null;
  /** When the usage happened, ISO-8601. Used only for rows that match no call. */
  occurredAt: string;
  model: string;
  /** Billed audio seconds, when xAI reports duration. */
  audioSeconds: number | null;
  /** Billed cost in micro-USD, when xAI reports cost. Wins over audioSeconds. */
  costMicros: number | null;
  inputTokens?: number;
  outputTokens?: number;
}

/** One Twilio Call resource (parent call or a child leg). */
export interface TwilioCallRow {
  callSid: string;
  parentCallSid: string | null;
  /** ISO-8601 UTC. */
  startTime: string;
  durationSeconds: number;
  /** Absolute micro-USD; null while Twilio has not priced the call yet. */
  priceMicros: number | null;
  priceUnit: string | null;
  status: string;
}

/** One Twilio Recording resource. */
export interface TwilioRecordingRow {
  recordingSid: string;
  callSid: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  durationSeconds: number;
  priceMicros: number | null;
  priceUnit: string | null;
}

/** Our call row (call_sessions LEFT JOIN conversation_costs), keyed by Twilio CallSid. */
export interface DbCallRow {
  callSid: string;
  callSessionId: string;
  tenantId: string;
  /** ISO-8601 UTC. */
  startedAt: string;
  durationSeconds: number | null;
  /** What we estimated at call time; null when no conversation_costs row exists. */
  estimate: {
    /** conversation_costs.llm_cost_cents (the xAI estimate). */
    xaiCents: number;
    /** conversation_costs.twilio_price_cents as micros; null if never captured. */
    twilioMicros: number | null;
  } | null;
}

export interface ReconcileInput {
  /** Local calendar date, YYYY-MM-DD (America/New_York). */
  date: string;
  xaiUsage: readonly XaiUsageRow[];
  twilioCalls: readonly TwilioCallRow[];
  twilioRecordings: readonly TwilioRecordingRow[];
  dbCalls: readonly DbCallRow[];
}

export interface CallCost {
  callSid: string;
  callSessionId: string | null;
  tenantId: string | null;
  startedAt: string;
  durationSeconds: number;
  durationSource: 'twilio' | 'db' | 'none';
  minutes: number;
  xaiCents: number;
  twilioVoiceCents: number;
  recordingCents: number;
  totalCents: number;
  centsPerMinute: number | null;
  micros: { xai: number; twilioVoice: number; recording: number; total: number };
  sources: { db: boolean; twilio: boolean; xai: boolean };
  twilioChildLegSids: string[];
  recordingSids: string[];
  xaiUsageIds: string[];
  estimateCents: number | null;
  /** reconciled − estimate, cents; null without an estimate. */
  deltaCents: number | null;
}

export interface UnmatchedXaiUsage {
  usageId: string;
  callSid: string | null;
  occurredAt: string;
  reason: 'unknown_call' | 'no_call_key';
  costCents: number;
}

export interface UnmatchedRecording {
  recordingSid: string;
  callSid: string;
  createdAt: string;
  costCents: number;
}

export interface UnmatchedChildLeg {
  callSid: string;
  parentCallSid: string;
  startTime: string;
  costCents: number;
}

export interface ReconciliationReport {
  date: string;
  timeZone: string;
  window: { startUtc: string; endUtc: string };
  /** False while any price is pending/unpriced or non-USD; re-run later. */
  complete: boolean;
  calls: CallCost[];
  totals: {
    calls: number;
    durationSeconds: number;
    minutes: number;
    xaiCents: number;
    twilioVoiceCents: number;
    recordingCents: number;
    /** Cost tied to a call in `calls`. */
    attributedCents: number;
    /** In-window cost that matched no call (listed under `unmatched`). */
    unattributedCents: number;
    /** attributed + unattributed, rounded once from micros. */
    totalCents: number;
    /** All-in cost per call minute. */
    centsPerMinute: number | null;
    micros: {
      xai: number;
      twilioVoice: number;
      recording: number;
      attributed: number;
      unattributed: number;
      total: number;
    };
  };
  /** Estimate vs reconciled over calls that have a DB estimate; null if none do. */
  estimate: {
    callsCompared: number;
    estimateCents: number;
    reconciledCents: number;
    deltaCents: number;
    /** delta ÷ estimate × 100, one decimal. */
    deltaPct: number | null;
  } | null;
  unmatched: {
    xaiUsageWithoutCall: UnmatchedXaiUsage[];
    callsWithoutXaiUsage: string[];
    twilioCallsWithoutDbCall: string[];
    dbCallsWithoutTwilioCall: string[];
    recordingsWithoutCall: UnmatchedRecording[];
    twilioChildLegsWithoutCall: UnmatchedChildLeg[];
  };
  incomplete: {
    twilioPricePending: string[];
    recordingPricePending: string[];
    xaiUnpriced: string[];
    nonUsd: string[];
  };
  /** Rows outside the day that matched no in-day call; counted, not costed. */
  outOfWindowIgnored: { xaiUsage: number; twilioCalls: number; recordings: number; dbCalls: number };
}
