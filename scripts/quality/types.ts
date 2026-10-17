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
  };
  waitlist?: {
    count?: number;
  };
};

export type ScenarioExpect = {
  actions?: ExpectedAction[];
  endState?: EndStateExpect;
  mustSay?: string[];
  mustNotSay?: string[];
  readbackRequired?: boolean;
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
  status: 'held' | 'confirmed' | 'cancelled';
  staffId: string;
  staffName: string;
  serviceIds: string[];
  start: string;
  startLocal: string;
  customerName: string;
  customerPhone: string;
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

export type CheckName = 'actions' | 'endState' | 'mustSay' | 'mustNotSay' | 'readbackRequired';

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
