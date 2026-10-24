/**
 * Per-call runtime invariants (RT-12): wires the pure RT-04 checker
 * (platform/callcore/invariants) and the RT-02 hangup floor
 * (tickets.file_floor) into the live voice runtime.
 *
 * One instance per realtime session. It owns the call's CallFacts and replaces
 * them with the RT-04 reducers' return values. It blocks hard violations
 * only, never writes speech for the caller and never picks the next question:
 * a block goes back to the model as the tool's output, carrying RT-04's fixed
 * instruction for the rule.
 *
 * - RUN (tool bridge, before a tool runs): checkRun. Legacy tools map to read
 *   or write, so the commit rules only reach two-phase platform actions.
 * - TRANSFER: checkTransfer before a tool that dials a number.
 * - END: checkEnd before a model-initiated end-call tool. A missing floor is
 *   evaluated, not refused. Silence-watchdog, max-duration and caller hangups
 *   never come through here.
 * - SAY: observe-only. Speech streams to the caller before its transcript is
 *   complete, so a finished agent turn is checked, the rule id is logged and
 *   counted, and nothing is sent to the model or cancelled.
 * - Floor: evaluateFloor() runs tickets.file_floor at most once per call, as
 *   the system actor, bounded in time, and never throws. The action decides
 *   never_heard / nothing_substantive / already_filed / filed; the runtime only
 *   skips it when a write or transfer tool on this call returned ok, because
 *   hasCallArtifact can't see every legacy write.
 */
import {
  appendRun,
  checkEnd,
  checkRun,
  checkSay,
  checkTransfer,
  createCallFacts,
  onAgentSpoke,
  onCallerHeard,
  onExplicitYes,
  onFloorEvaluated,
  onPrepared,
  onToolResult,
  type ActionKind,
  type CallFacts,
  type CheckResult,
  type RuleId,
  type RunRecord,
  type RunRequest,
} from '../../../platform/callcore/invariants';
import {
  actionNameFromExternal,
  assignExternalToolNames,
  getAction,
  listActions,
  runAction,
  type ActionContext,
  type ActionResult,
  type ExternalToolNames,
} from '../../../platform/actions';
import { FILE_FLOOR, floorIdempotencyKey, type FileFloorInput, type FileFloorOutput } from '../../../platform/actions/tickets';
import { envSmsSendConfig } from '../../../platform/actions/sms/deps';
import { isToolStoppedResult } from '../../../platform/tools/ToolStopGuard';
import { isPendingBookingChallenge } from '../../../platform/tools/library/handlers/createBooking';
import { isExplicitYes, type ConfirmAction } from '../../../platform/reasoning/confirmationLanguage';
import { CallerLineBuffer } from './callerLines';

/** The runtime's actor for system-only actions (the floor). */
export const VOICE_RUNTIME_ACTOR = { type: 'system', id: 'voice-runtime' } as const;

/** Most time evaluateFloor() may take, tool settling included. */
export const FLOOR_DEADLINE_MS = 8_000;
/** Most of that spent waiting for tools still running at hangup. */
export const FLOOR_TOOL_SETTLE_MS = 3_000;

/**
 * Legacy tools that only read, or only keep runtime bookkeeping (a language
 * note, the model's own disposition). They leave no record for the shop, so
 * they don't stop the floor. Every other legacy tool counts as a write.
 */
export const LEGACY_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_current_tenant_time',
  'record_language_change',
  'record_call_outcome',
  'lookup_customer',
  'retrieve_knowledge',
  'lookupSchedule',
  // Workforce handoff: a role switch inside the same call, not a phone transfer.
  'transfer_to_agent',
]);

/**
 * Model-initiated end-call tools. No live agent exposes one today (see
 * callOutcome.ts), so END has no live effect until one is added.
 */
export const END_CALL_TOOLS: ReadonlySet<string> = new Set(['end_call']);

/** Whether this call dials a phone number: triage always does; escalate_to_human only with transfer_number. */
export function isTransferRequest(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'triageEscalate') return true;
  return toolName === 'escalate_to_human' && typeof args.transfer_number === 'string' && args.transfer_number.trim() !== '';
}

let externalNames: ExternalToolNames | undefined;

/** The two-phase platform action behind a tool name (its action name, or the sanitized external name). */
function platformAction(toolName: string) {
  const direct = getAction(toolName);
  if (direct) return direct;
  externalNames ??= assignExternalToolNames(listActions().map((def) => def.name));
  const name = actionNameFromExternal(toolName, externalNames);
  return name ? getAction(name) : undefined;
}

function platformActionKind(toolName: string): ActionKind | undefined {
  return platformAction(toolName)?.kind;
}

// Which go-aheads a prepared readback takes: "book it" confirms only a booking.
const CONFIRM_ACTIONS: Readonly<Record<string, ConfirmAction>> = {
  'scheduling.book.prepare': 'book',
  'scheduling.cancel.prepare': 'cancel',
  'scheduling.reschedule.prepare': 'reschedule',
};

/** How RUN and the call facts see a tool. */
export function toolKind(toolName: string, args: Record<string, unknown>): ActionKind {
  const platform = platformActionKind(toolName);
  if (platform) return platform;
  if (isTransferRequest(toolName, args)) return 'transfer';
  if (LEGACY_READ_TOOLS.has(toolName) || END_CALL_TOOLS.has(toolName)) return 'read';
  return 'write';
}

function parseObject(output: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a tool output is a success: not `success:false` / `ok:false`, not
 * the stop guard's result, not a booking readback still waiting for a yes.
 * Output that isn't a JSON object counts as a success (the bridge always
 * returns JSON), which keeps the floor on the no-double-filing side.
 */
export function toolOutputOk(output: string): boolean {
  const parsed = parseObject(output);
  if (!parsed) return true;
  if (parsed.success === false || parsed.ok === false) return false;
  if (isToolStoppedResult(parsed)) return false;
  return !isPendingBookingChallenge(parsed as { pending?: boolean; status?: string });
}

function confirmationTokenOf(value: Record<string, unknown> | null | undefined): string | undefined {
  if (!value) return undefined;
  const direct = value.confirmationToken;
  if (typeof direct === 'string' && direct) return direct;
  const data = value.data;
  if (data && typeof data === 'object') {
    const nested = (data as Record<string, unknown>).confirmationToken;
    if (typeof nested === 'string' && nested) return nested;
  }
  return undefined;
}

/** Tool argument keys that carry the caller's own name (legacy ticket and booking tools). */
const NAME_ARG_KEYS = ['callerName', 'customerName', 'customer_name', 'contactName', 'contact_name'];
const MAX_CALLER_NAME_LENGTH = 255;

function callerNameFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of NAME_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_CALLER_NAME_LENGTH);
  }
  return undefined;
}

function floorLanguage(value: unknown): 'en' | 'es' | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toLowerCase();
  if (code.startsWith('es')) return 'es';
  if (code.startsWith('en')) return 'en';
  return undefined;
}

export { isExplicitYes };

export type FloorOutcome =
  | FileFloorOutput['reason']
  | 'skipped_tool_write'
  | 'skipped_tool_in_flight'
  | 'skipped_outbound'
  | 'action_failed'
  | 'timeout'
  | 'error';

export type FloorActionRunner = (ctx: ActionContext, input: FileFloorInput) => Promise<ActionResult>;

/** Production: the platform action layer with its default registry, store and tenant transaction. */
const runFloorThroughActions: FloorActionRunner = (ctx, input) => runAction(FILE_FLOOR, ctx, input);

export interface InvariantLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
}

export interface CallInvariantsAgent {
  tools: ReadonlyArray<{ name: string }>;
  metadata?: Record<string, unknown>;
  language?: string;
  preferredLanguage?: string;
  timeZone?: string;
}

export interface CallInvariantsInit {
  tenantId: string;
  /** call_sessions.id: what hasCallArtifact and the floor ticket's call_id key on. */
  callId: string;
  agent: CallInvariantsAgent;
  callerNumber?: string;
  calledNumber?: string;
  /**
   * The floor protects a caller's lost request, so it only runs on inbound
   * calls; an outbound callee never gets a floor ticket. Defaults to inbound.
   */
  direction?: 'inbound' | 'outbound';
  log: InvariantLogger;
  /** Tests inject a fake; production runs the action through platform/actions. */
  runFloorAction?: FloorActionRunner;
  /** Existing SMS kill switch (SMS_ENABLED); read once per call. */
  smsEnabled?: () => boolean;
  now?: () => Date;
  floorDeadlineMs?: number;
  toolSettleMs?: number;
  /**
   * Runs once the tools in flight have settled, before the floor decides:
   * the session flushes its bookkeeping queue here (bounded, never rejects),
   * so every row a tool queued is written before the floor reads the call.
   */
  beforeFloor?: () => Promise<unknown>;
}

/** Process-wide SAY observations by rule, for metrics. */
const sayObservedTotals = new Map<RuleId, number>();

export function sayObservedTotal(rule: RuleId): number {
  return sayObservedTotals.get(rule) ?? 0;
}

type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

/** A timer the caller always cancels once the race it bounds is over. */
function sleep(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class CallInvariants {
  private state: CallFacts;
  private history: RunRecord[] = [];
  private readonly callerLines = new CallerLineBuffer();
  private readonly inFlight = new Map<Promise<unknown>, ActionKind>();
  private readonly sayCounts = new Map<RuleId, number>();
  /** A write, commit or transfer tool returned ok on this call (legacy writes hasCallArtifact may not see). */
  private filedByTool = false;
  private callerName: string | undefined;
  private language: 'en' | 'es' | undefined;
  private lastPreparedToken: string | undefined;
  private lastPreparedAction: ConfirmAction | undefined;
  private spokeSincePrepare = false;
  private floor: Promise<FloorOutcome> | undefined;
  private readonly runFloor: FloorActionRunner;
  private readonly now: () => Date;

  constructor(private readonly init: CallInvariantsInit) {
    const meta = init.agent.metadata ?? {};
    const transferNumber = nonEmpty(meta.onCallTransferNumber);
    this.state = createCallFacts({
      callId: init.callId,
      // The number the existing transfer paths dial (stream.ts onEscalation).
      transferNumberConfigured: Boolean(transferNumber),
      // No agent config sets it today; D7's default is refs texted, not spoken.
      voiceRefs: meta.voiceRefs === true,
      smsEnabled: (init.smsEnabled ?? envSmsSendConfig.smsEnabled)(),
      allowedActions: init.agent.tools.map((tool) => tool.name),
      speakableNumbers: [init.calledNumber, init.callerNumber, transferNumber, nonEmpty(meta.businessPhone)].filter(
        (n): n is string => Boolean(n && n.trim()),
      ),
    });
    this.language = floorLanguage(init.agent.preferredLanguage ?? init.agent.language);
    this.runFloor = init.runFloorAction ?? runFloorThroughActions;
    this.now = init.now ?? (() => new Date());
  }

  get facts(): CallFacts {
    return this.state;
  }

  /** SAY rules observed on this call, by rule. */
  get sayObservations(): ReadonlyMap<RuleId, number> {
    return this.sayCounts;
  }

  get callerLineCount(): number {
    return this.callerLines.size;
  }

  /** A workforce handoff exposed a new tool list to the model. */
  setExposedTools(tools: ReadonlyArray<{ name: string }>): void {
    this.state = { ...this.state, allowedActions: tools.map((tool) => tool.name) };
  }

  /** A caller transcript completed. */
  callerTranscribed(text: string): void {
    if (!text.trim()) return;
    this.state = onCallerHeard(this.state);
    this.callerLines.push(text);
    if (this.lastPreparedToken && this.spokeSincePrepare && isExplicitYes(text, this.lastPreparedAction)) {
      this.state = onExplicitYes(this.state, this.lastPreparedToken);
    }
  }

  /** An agent turn's transcript completed: SAY (observe-only), then the pending result counts as voiced. */
  agentTurnCompleted(text: string): void {
    if (text.trim()) {
      const said = checkSay(this.state, text);
      if (!said.ok) {
        const count = (this.sayCounts.get(said.rule) ?? 0) + 1;
        this.sayCounts.set(said.rule, count);
        sayObservedTotals.set(said.rule, (sayObservedTotals.get(said.rule) ?? 0) + 1);
        this.init.log.info('invariant_say_observed', { rule: said.rule, count });
      }
    }
    this.state = onAgentSpoke(this.state);
    this.spokeSincePrepare = true;
  }

  /**
   * Wraps the tool bridge: RUN, TRANSFER and END run before the tool, and the
   * real result updates the facts after it. A block returns the instruction
   * without running the tool, so ToolStopGuard never counts it.
   */
  wrapToolHandler(handler: ToolHandler): ToolHandler {
    return (name, args) => {
      const kind = toolKind(name, args);
      const work = this.runTool(handler, name, args, kind);
      // The end-call tool evaluates the floor itself; it must not wait on itself.
      if (END_CALL_TOOLS.has(name)) return work;
      // In flight from the moment the bridge has it, so a teardown landing
      // during the gate still waits for it.
      const tracked = work.then(
        () => undefined,
        () => undefined,
      );
      this.inFlight.set(tracked, kind);
      void tracked.then(() => this.inFlight.delete(tracked));
      return work;
    };
  }

  private async runTool(handler: ToolHandler, name: string, args: Record<string, unknown>, kind: ActionKind): Promise<string> {
    const run: RunRequest = { action: name, kind, confirmationToken: confirmationTokenOf(args), args };
    const gate = await this.gate(run);
    if (!gate.ok) return this.blocked(name, gate);

    const callerName = callerNameFromArgs(args);
    if (callerName) this.callerName = callerName;

    let output: string | undefined;
    try {
      output = await handler(name, args);
      return output;
    } finally {
      this.afterTool(name, args, run, output);
    }
  }

  private async gate(run: RunRequest): Promise<CheckResult> {
    const ran = checkRun(this.state, run, this.history);
    if (!ran.ok) return ran;
    if (run.kind === 'transfer') {
      const transfer = checkTransfer(this.state);
      if (!transfer.ok) return transfer;
    }
    if (END_CALL_TOOLS.has(run.action)) return this.beforeAgentEnd();
    return { ok: true };
  }

  /**
   * END for a model-initiated hangup. The floor runs first if it hasn't, so
   * the call is never refused for it; an unvoiced tool result returns the
   * instruction so she speaks it before hanging up.
   */
  async beforeAgentEnd(): Promise<CheckResult> {
    let result = checkEnd(this.state, 'agent_goodbye');
    if (!result.ok && result.rule === 'end.floor_not_evaluated') {
      await this.evaluateFloor();
      result = checkEnd(this.state, 'agent_goodbye');
    }
    return result;
  }

  private blocked(toolName: string, result: Extract<CheckResult, { ok: false }>): string {
    this.init.log.warn('invariant_block', { rule: result.rule, tool: toolName });
    return JSON.stringify({ success: false, code: 'INVARIANT_BLOCKED', rule: result.rule, message: result.instruction });
  }

  private afterTool(name: string, args: Record<string, unknown>, run: RunRequest, output: string | undefined): void {
    const parsed = output === undefined ? null : parseObject(output);
    const ok = output !== undefined && toolOutputOk(output);
    // A transfer only counts once the caller was actually connected.
    const factOk = run.kind === 'transfer' ? ok && parsed?.transferred !== false : ok;
    this.state = onToolResult(this.state, {
      action: name,
      kind: run.kind,
      ok: factOk,
      confirmationToken: run.kind === 'commit' ? run.confirmationToken : undefined,
    });
    this.history = appendRun(this.history, run, ok);
    if (ok && (run.kind === 'write' || run.kind === 'commit' || run.kind === 'transfer')) this.filedByTool = true;
    if (ok && run.kind === 'prepare') {
      const token = confirmationTokenOf(parsed);
      if (token) {
        this.state = onPrepared(this.state, token);
        this.lastPreparedToken = token;
        const action = platformAction(name)?.name;
        this.lastPreparedAction = action ? CONFIRM_ACTIONS[action] : undefined;
        this.spokeSincePrepare = false;
      }
    }
    if (ok && name === 'record_language_change') this.language = floorLanguage(args.language) ?? this.language;
  }

  /**
   * The hangup floor, at most once per call (later calls get the first
   * outcome). Waits briefly for tools still running, then runs
   * tickets.file_floor. Bounded by the deadline; never throws. Logs only the
   * outcome code.
   */
  evaluateFloor(): Promise<FloorOutcome> {
    this.floor ??= this.runFloorOnce();
    return this.floor;
  }

  private async runFloorOnce(): Promise<FloorOutcome> {
    const deadline = sleep(this.init.floorDeadlineMs ?? FLOOR_DEADLINE_MS);
    let outcome: FloorOutcome;
    try {
      outcome = await Promise.race([this.floorSteps(), deadline.promise]);
    } catch {
      outcome = 'error';
    } finally {
      deadline.cancel();
    }
    this.state = onFloorEvaluated(this.state);
    this.init.log.info('floor_evaluated', { outcome });
    return outcome;
  }

  private async floorSteps(): Promise<FloorOutcome> {
    // Covers both teardown and a model-initiated END on an outbound call.
    if (this.init.direction === 'outbound') return 'skipped_outbound';
    if (this.inFlight.size > 0) {
      const settle = sleep(this.init.toolSettleMs ?? FLOOR_TOOL_SETTLE_MS);
      await Promise.race([Promise.all([...this.inFlight.keys()]), settle.promise]);
      settle.cancel();
    }
    await this.init.beforeFloor?.();
    if (this.filedByTool) return 'skipped_tool_write';
    if ([...this.inFlight.values()].some((kind) => kind !== 'read')) return 'skipped_tool_in_flight';

    const ctx: ActionContext = {
      tenantId: this.init.tenantId,
      actor: { ...VOICE_RUNTIME_ACTOR },
      now: this.now(),
      tenantTimezone: this.init.agent.timeZone || 'UTC',
      callId: this.init.callId,
      idempotencyKey: floorIdempotencyKey(this.init.callId),
      ...(this.language ? { locale: this.language } : {}),
    };
    const input: FileFloorInput = {
      callId: this.init.callId,
      callerLines: this.callerLines.lines(),
      ...(this.callerName ? { callerName: this.callerName } : {}),
      ...(this.language ? { language: this.language } : {}),
    };
    const result = await this.runFloor(ctx, input);
    if (!result.ok) {
      this.init.log.warn('floor_action_failed', { code: result.error.code });
      return 'action_failed';
    }
    return (result.data as FileFloorOutput).reason;
  }
}
