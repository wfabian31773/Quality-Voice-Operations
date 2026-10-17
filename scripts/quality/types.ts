/**
 * Quality-harness types. Mirrors spec §0.1 enough to drive text simulations
 * without importing `platform/actions` (owned by PR-01).
 */

export const TEMPLATES = ['barbershop', 'nail_salon'] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export const TOOLS = [
  'scheduling',
  'sms',
  'tickets',
  'dispatch',
  'orders',
  'business',
  'calls',
] as const;
export type ToolName = (typeof TOOLS)[number];

export type CallerTurn = {
  text?: string;
  silence?: boolean | number;
  interrupt?: boolean;
};

export type ScriptCall = {
  name: string;
  input?: Record<string, unknown>;
};

export type ScriptStep = { call: ScriptCall } | { say: string };

export type ScriptTurn = {
  /** Caller-turn index this plan answers. Defaults to the array index. */
  on?: number;
  steps: ScriptStep[];
};

export type ExpectedAction = {
  name: string;
  input?: Record<string, unknown>;
};

export type ExpectedBooking = {
  status?: string;
  startLocal?: string;
  /** Calendar date (YYYY-MM-DD) the booking must fall on. */
  date?: string;
  staffId?: string;
  staffName?: string;
};

export type TimeMatchContext = {
  /** Scenario local calendar date (YYYY-MM-DD). Bare HH:MM values match only this date. */
  date: string;
  timeZone: string;
};

export type EndStateExpect = {
  bookings?: {
    count?: number;
    items?: ExpectedBooking[];
  };
  tickets?: {
    count?: number;
    kind?: string;
    status?: string;
  };
  transfers?: {
    count?: number;
    to?: string;
    status?: string;
  };
  waitlist?: {
    count?: number;
  };
};

/** What the ReasoningEngine gate did during the scenario (see ReasoningSetup). */
export type ReasoningExpect = {
  mode?: 'enforce' | 'shadow';
  /** Guidance injected into the agent (enforce only; shadow must be 0). */
  injections?: number;
  /** Tool calls the gate blocked. */
  blockedTools?: number;
  /** At least this many reasoning_shadow log lines. */
  minShadowLines?: number;
};

export type ScenarioExpect = {
  actions?: ExpectedAction[];
  endState?: EndStateExpect;
  mustSay?: string[];
  mustNotSay?: string[];
  readbackRequired?: boolean;
  reasoning?: ReasoningExpect;
  /** Executed attempts per tool (a TOOL_STOPPED call is not an attempt). */
  toolAttempts?: Record<string, number>;
};

/**
 * Run the call's caller turns and tool calls through the real
 * ReasoningEngine + ReasoningCallGate, with the mode resolved like a live
 * call (agent metadata → tenant settings → vertical default).
 */
export type ReasoningSetup = {
  agentType: string;
  agentMetadata?: Record<string, unknown>;
  tenantSettings?: Record<string, unknown>;
};

/** Make a tool fail before it runs, for its first `failTimes` attempts. */
export type ToolFault = {
  failTimes: number;
  code?: string;
  retryable?: boolean;
};

export type Scenario = {
  id: string;
  template: TemplateId;
  tools: ToolName[];
  tags: string[];
  seed: string;
  now?: string;
  caller: CallerTurn[];
  script?: ScriptTurn[];
  expect: ScenarioExpect;
  expectedFail?: string;
  /**
   * The call's trusted caller ID (call_sessions.caller_number), E.164; null =
   * blocked. Omitted = the seed's `callerNumber`. Never sent as tool input.
   */
  callerId?: string | null;
  reasoning?: ReasoningSetup;
  toolFaults?: Record<string, ToolFault>;
};

export type Actor = {
  type: 'user' | 'agent' | 'mcp' | 'system';
  id: string;
  role?: string;
  scopes?: string[];
};

export type ToolCallContext = {
  tenantId: string;
  actor: Actor;
  now: Date;
  tenantTimezone: string;
  callId: string;
  conversationId?: string;
  locale?: string;
  idempotencyKey?: string;
};

export type ToolError = {
  code: string;
  message: string;
  callerSafeMessage: string;
  retryable: boolean;
  field?: string;
  alternatives?: unknown[];
};

export type ToolResult =
  | { ok: true; data: unknown; readback?: string }
  | { ok: false; error: ToolError };

export type AgentToolSchema = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
};

/**
 * Plug point for PR-01's action registry. The harness never imports
 * `platform/actions`; a later adapter implements this interface.
 */
export interface ToolProvider {
  listTools(): AgentToolSchema[];
  invoke(name: string, input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult>;
}

export type TraceEvent =
  | { type: 'caller'; turn: CallerTurn }
  | { type: 'tool'; name: string; input: Record<string, unknown>; result: ToolResult }
  | { type: 'say'; text: string };

export type BookingRow = {
  id: string;
  /** 'rescheduled' = superseded by the booking a reschedule commit confirmed. */
  status: 'held' | 'confirmed' | 'cancelled' | 'rescheduled';
  staffId: string;
  staffName: string;
  serviceIds: string[];
  start: string;
  startLocal: string;
  customerName: string;
  customerPhone: string;
  /** Set when a hold is released (bookings.cancellation_reason: 'hold_superseded' | 'hold_expired'). */
  cancellationReason?: string;
};

export type TicketRow = {
  id: string;
  status: 'held' | 'open';
  kind: string;
  subject: string;
};

export type TransferRow = {
  to: string;
  status: 'held' | 'committed';
};

export type WaitlistRow = {
  id: string;
  serviceIds: string[];
  date?: string;
};

export type EndSnapshot = {
  bookings: BookingRow[];
  tickets: TicketRow[];
  transfers: TransferRow[];
  waitlist: WaitlistRow[];
};

export type CheckName = 'actions' | 'endState' | 'mustSay' | 'mustNotSay' | 'readbackRequired' | 'reasoning' | 'toolAttempts';

export type CheckFailure = {
  check: CheckName;
  message: string;
  expected?: unknown;
  actual?: unknown;
};

export type ScenarioStatus = 'passed' | 'failed' | 'expected_fail' | 'unexpected_pass';

export type ScenarioRunResult = {
  id: string;
  status: ScenarioStatus;
  expectedFail?: string;
  failures: CheckFailure[];
  diff: string;
  trace: TraceEvent[];
  snapshot: EndSnapshot;
  reasoning?: ReasoningObservation;
  toolAttempts?: Record<string, number>;
};

export type ReasoningObservation = {
  mode: 'enforce' | 'shadow';
  /** reasoning_shadow lines, as logged. */
  shadowLines: Array<Record<string, unknown>>;
  /** Template ids the gate handed back to apply (enforce only). */
  injections: string[];
  blocked: Array<{ tool: string; reason: string }>;
};

export type RunReport = {
  ok: boolean;
  mode: 'scripted' | 'llm';
  startedAt: string;
  finishedAt: string;
  passed: string[];
  failed: string[];
  expectedFailed: Array<{ id: string; expectedFail: string }>;
  unexpectedPassed: Array<{ id: string; expectedFail: string }>;
  results: ScenarioRunResult[];
};
