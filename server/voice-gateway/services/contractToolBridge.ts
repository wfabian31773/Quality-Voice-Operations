/**
 * Contract tool bridge (RT-09). A composer agent's contract tools (the
 * platform actions its contracts name) run here, through runAction, with the
 * agent's server-injected ActionContext: tenant, call session id, caller
 * number, the call's language and actor = agent. Contract enforcement,
 * two-phase prepare/commit, readback and idempotency are the actions' own
 * rules; this file only calls them.
 *
 * It sits inside openaiSession's tool handler, so CallInvariants (RT-12)
 * wraps it like every other tool: RUN (allowed action, commit only with a
 * prepared token and an explicit yes) runs before a call reaches here, and
 * the floor sees the result after.
 *
 * What it adds to an action result, both from the composed template:
 * - SLOT_MISSING (an ask, not an exit): callerSafeMessage becomes the
 *   template's phrasing of that askId in the call's language.
 * - An ok commit with an after-write line: `say` = that line around the
 *   commit's readback, in the commit's own language (the proposal's locale,
 *   which the commit's readback also uses), plus "a text will follow once
 *   texting is enabled" while SMS is off.
 *
 * The guards legacy tools get in executeWithRetry, which this path skips:
 * - each action run is cut off after the legacy per-attempt timeout (15s), so
 *   the caller is never left in dead air (the silence watchdog is paused
 *   during a tool run). It is never retried here. A timed-out read says "try
 *   again or take a message"; a timed-out commit or write may still land, so
 *   its line never says it failed and never invites a second booking: the
 *   shop follows up (and a text follows once texting is enabled) and she
 *   offers a message. A timed-out prepare says she can't confirm it right now
 *   and offers a message;
 * - the repeated-tool stop: once a tool has failed TOOL_STOP_THRESHOLD times
 *   in the call, it returns ToolStopGuard's stop result and no longer runs.
 *   For a write that timed out on this call, the stop result keeps the same
 *   "can't confirm yet" wording instead of "could not complete it".
 *   SLOT_MISSING is an ask with its own ceiling (the contract's exit), so it
 *   doesn't count;
 * - the per-tenant tool rate limit (unifiedToolRegistry.checkRateLimit).
 *
 * The model never sees an internal id: results go out through CallHandles
 * (contractToolHandles.ts) and handles come back in through it. An ok commit
 * is cut down first to its contract's sayBack fields plus what a later tool
 * call needs (commitView). execute()
 * also says how the run ended, for openaiSession's tool bookkeeping
 * (tool_invocations, call events, metering).
 */
import { randomUUID } from 'node:crypto';
import { afterWriteLine, contractActionNames, type ContractToolBinding } from '../../../platform/agent-runtime/composer';
import { templateLanguage, type Phrase, type TemplateLanguage } from '../../../platform/agent-templates/shared';
import { actionFail, getAction, runAction, type ActionContext, type ActionResult } from '../../../platform/actions';
import { envSmsSendConfig } from '../../../platform/actions/sms/deps';
import { CONTRACTS } from '../../../platform/callcore/contracts';
import { isCallerIdReference } from '../../../platform/reasoning/sessionBinding';
import { DEFAULT_RETRY_CONFIG } from '../../../platform/tools/RetryOrchestrator';
import { unifiedToolRegistry } from '../../../platform/tools/ToolRegistry';
import { toolStopGuard, TOOL_STOPPED_CODE, type ToolStopGuard, type ToolStoppedResult } from '../../../platform/tools/ToolStopGuard';
import { CallHandles, NEXT_CALL_KEYS, REF_KEYS } from './contractToolHandles';

/** Production runs platform/actions' runAction; tests inject a fake. */
export type ContractActionRunner = (name: string, ctx: ActionContext, input: unknown) => Promise<ActionResult>;

/** The language note the runtime's record_language_change tool takes. */
const LANGUAGE_TOOL = 'record_language_change';

/** The per-attempt timeout legacy tools get (RetryOrchestrator's withTimeout, DEFAULT_RETRY_CONFIG.timeoutMs). */
export const CONTRACT_TOOL_TIMEOUT_MS = DEFAULT_RETRY_CONFIG.timeoutMs;

/** A read that timed out: nothing changed, so another try is fine. */
export const READ_TIMED_OUT: Phrase = {
  en: "Sorry, I couldn't check that just now. We can try again in a moment, or I can take a message for the shop.",
  es: 'Disculpe, no pude revisarlo en este momento. Podemos intentarlo otra vez en un momento, o le puedo tomar un mensaje.',
};

/** A prepare that timed out: no readback came back, so nothing is booked; a hold may sit until it expires. */
export const PREPARE_TIMED_OUT: Phrase = {
  en: "I'm sorry, the system is slow and I can't confirm that right now. I can take a message so the shop can follow up with you about it.",
  es: 'Disculpe, el sistema está lento y no puedo confirmarlo en este momento. Le puedo tomar un mensaje para que le den seguimiento.',
};

/** A commit or write that timed out may still land: never "it failed", never "book it again". */
const STILL_CONFIRMING: Phrase = {
  en: "I'm still waiting on the system, so I can't confirm that right now.",
  es: 'Todavía estoy esperando al sistema, así que no puedo confirmarlo en este momento.',
};
/** While SMS is off; followed by the template's "a text will follow once texting is enabled". */
const SHOP_WILL_CONFIRM: Phrase = {
  en: 'The shop will follow up with you to confirm it.',
  es: 'Le van a dar seguimiento para confirmárselo.',
};
/** Once SMS is on. */
const TEXT_OR_FOLLOW_UP: Phrase = {
  en: "You'll get a confirmation text or a follow-up from the shop.",
  es: 'Le llegará un mensaje de confirmación o le darán seguimiento.',
};
const OFFER_MESSAGE: Phrase = {
  en: 'I can also take a message for them.',
  es: 'También le puedo tomar un mensaje.',
};

/** What the model is told about a timed-out write (never voiced). */
const WRITE_TIMED_OUT_NOTE =
  'The action timed out and may still have gone through. Do not call it again, do not say it failed and do not offer to do it again: '
  + 'say the callerSafeMessage, then offer to take a message.';

type TimeoutClass = 'read' | 'prepare' | 'write';

/** How a timeout is worded: by the action's kind. An unknown kind is treated as a write (the safe side). */
function timeoutClass(kind: string | undefined): TimeoutClass {
  if (kind === 'read') return 'read';
  if (kind === 'prepare') return 'prepare';
  return 'write';
}

class ActionTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ActionTimeout()), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** An ask (SLOT_MISSING, with or without its exit) has its own ceiling; every other failure counts toward the stop. */
function countsAsFailure(result: ActionResult): boolean {
  return !result.ok && result.error.code !== 'SLOT_MISSING';
}

/** How one contract tool call ended, for the session's tool bookkeeping. */
export interface ContractToolRun {
  /** The JSON the model gets. */
  output: string;
  /** tool_invocations status: an ask (SLOT_MISSING) is a success, like an ok result; a timeout is 'timeout'. */
  status: 'success' | 'failed' | 'timeout';
  /** The action returned ok (an ask, a failure or a stop did not). */
  ok: boolean;
  /** "<code>: <message>" from the model's view (no internal ids), for a run that isn't a success. */
  errorMessage?: string;
  /** Refused by the rate limit before anything ran (legacy records those without call events or metering). */
  rateLimited: boolean;
}

/** Action → the refs (ticketNumber, …) its contract's sayBack lets the model see. */
const SPEAKABLE_REFS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  CONTRACTS.flatMap((contract) => {
    const refs = new Set(contract.sayBack.filter((field) => REF_KEYS.has(field)));
    return contractActionNames(contract).map((action) => [action, refs] as const);
  }),
);

/** Commit action → its contract's sayBack fields (the top-level key of each, as the commit outputs it). */
const COMMIT_SAY_BACK: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  CONTRACTS.flatMap((contract) =>
    contract.confirm ? [[contract.confirm.commit, new Set(contract.sayBack.map((field) => field.split('.')[0]))] as const] : []),
);

/**
 * An ok commit as the model gets it: the contract's sayBack fields, plus what
 * a later tool call takes back in (the confirmation token, and the call-scoped
 * handle fields, e.g. the booking a later move or cancel names). Everything
 * else the action returned (status, times, previousBookingId, ticket ids and
 * numbers, effects) stays on the server: these contracts have voiceRefs false.
 */
function commitView(action: string, result: Extract<ActionResult, { ok: true }>): Extract<ActionResult, { ok: true }> {
  const sayBack = COMMIT_SAY_BACK.get(action) ?? new Set<string>();
  const data = asRecord(result.data) ?? {};
  const kept = Object.fromEntries(Object.entries(data).filter(([key]) => sayBack.has(key) || NEXT_CALL_KEYS.has(key)));
  return { ok: true, data: kept, ...(result.readback ? { readback: result.readback } : {}) };
}

function errorMessageOf(view: unknown): string | undefined {
  const record = asRecord(view);
  const error = asRecord(record?.error);
  if (error && typeof error.code === 'string') return `${error.code}: ${typeof error.message === 'string' ? error.message : ''}`.trim();
  return typeof record?.code === 'string' ? record.code : undefined;
}

export interface ContractToolBridgeInit {
  tenantId: string;
  /** call_sessions.id: the call the actions key their asks, holds and proposals on. */
  callId: string;
  agentId: string;
  binding: ContractToolBinding;
  timeZone: string;
  /** The call's starting language; record_language_change moves it. */
  language?: string;
  /** Caller ID from the telephony layer; never from model arguments. */
  callerNumber?: string;
  runAction?: ContractActionRunner;
  /** Existing SMS kill switch (SMS_ENABLED), as CallInvariants reads it. */
  smsEnabled?: () => boolean;
  now?: () => Date;
  newIdempotencyKey?: () => string;
  /** Defaults to CONTRACT_TOOL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Defaults to the process-wide guard openaiSession opens and clears per call. */
  stopGuard?: ToolStopGuard;
  /** Defaults to unifiedToolRegistry's per-tenant tool rate limit. */
  checkRateLimit?: (tenantId: string, toolName: string) => boolean;
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Drops a caller-ID reference ("caller_id", "the number I'm calling from",
 * blank) from an input path held from caller ID, so the action fills it from
 * the call instead of failing validation on it. A real number is kept.
 */
function withoutCallerIdReferences(args: Record<string, unknown>, paths: readonly string[] = []): Record<string, unknown> {
  if (paths.length === 0) return args;
  // Tool arguments arrive as parsed JSON, so a JSON round trip is a full copy.
  const input = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  for (const path of paths) {
    const keys = path.split('.');
    let parent: Record<string, unknown> | undefined = input;
    for (const key of keys.slice(0, -1)) parent = asRecord(parent?.[key]);
    const last = keys[keys.length - 1];
    if (parent && typeof parent[last] === 'string' && isCallerIdReference(parent[last])) delete parent[last];
  }
  return input;
}

/** The model sees caller-safe text only, never an exception message. */
function forModel(result: ActionResult): ActionResult {
  if (result.ok || result.error.code !== 'INTERNAL') return result;
  return { ok: false, error: { ...result.error, message: result.error.callerSafeMessage } };
}

const runThroughActions: ContractActionRunner = (name, ctx, input) => runAction(name, ctx, input);

export class ContractToolBridge {
  private language: TemplateLanguage;
  /** Prepare token → the language its proposal was made in (what its commit's readback speaks). */
  private readonly proposalLanguages = new Map<string, TemplateLanguage>();
  /** Call-scoped handles for the internal ids in action results. */
  private readonly idHandles = new CallHandles();
  /** Tools with a prepare or write that timed out on this call (it may still have landed). */
  private readonly uncertainWrites = new Map<string, Exclude<TimeoutClass, 'read'>>();
  private readonly run: ContractActionRunner;

  constructor(private readonly init: ContractToolBridgeInit) {
    this.language = templateLanguage(init.language);
    this.run = init.runAction ?? runThroughActions;
  }

  /** The call's current language. */
  get currentLanguage(): TemplateLanguage {
    return this.language;
  }

  /** Whether this tool name is one of the agent's contract tools. */
  handles(toolName: string): boolean {
    return hasOwn(this.init.binding.actions, toolName);
  }

  /** Sees every tool call the session gets; only a language change matters here. */
  observeToolCall(toolName: string, args: Record<string, unknown>): void {
    if (toolName === LANGUAGE_TOOL && typeof args.language === 'string') this.language = templateLanguage(args.language);
  }

  /** Runs a contract tool and returns the JSON the model gets. */
  async runTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    return (await this.execute(toolName, args)).output;
  }

  /**
   * Runs a contract tool: the JSON the model gets, and how the run ended.
   * `beforeRun` is awaited once the rate limit lets the call through, before
   * the stop check, where the legacy path opens its tool_invocations row.
   */
  async execute(toolName: string, args: Record<string, unknown>, hooks: { beforeRun?: () => Promise<void> } = {}): Promise<ContractToolRun> {
    const { binding } = this.init;
    const action = hasOwn(binding.actions, toolName) ? binding.actions[toolName] : undefined;
    if (!action) return this.finish(toolName, actionFail('NOT_FOUND', `Not a contract tool: ${toolName}`), 'failed');
    const withinLimit = this.init.checkRateLimit ?? ((tenantId, name) => unifiedToolRegistry.checkRateLimit(tenantId, name));
    if (!withinLimit(this.init.tenantId, toolName)) {
      const limited = actionFail('RATE_LIMITED', 'Rate limit exceeded for this tool. Please wait a moment before trying again.');
      return { ...this.finish(action, limited, 'failed'), rateLimited: true };
    }
    await hooks.beforeRun?.();
    const guard = this.init.stopGuard ?? toolStopGuard;
    const { callId } = this.init;
    if (guard.isStopped(callId, toolName)) return this.finish(action, this.stopResult(guard, toolName), 'failed');

    const kind = getAction(action)?.kind;
    const lang = this.language;
    const ctx: ActionContext = {
      tenantId: this.init.tenantId,
      actor: { type: 'agent', id: this.init.agentId },
      now: this.init.now?.() ?? new Date(),
      callId: this.init.callId,
      locale: lang,
      tenantTimezone: this.init.timeZone || 'UTC',
      ...(this.init.callerNumber?.trim() ? { callerPhone: this.init.callerNumber.trim() } : {}),
      // A commit is keyed by its confirmation token (runAction); a prepare gets its own key.
      ...(kind === 'prepare' || kind === 'write' ? { idempotencyKey: (this.init.newIdempotencyKey ?? randomUUID)() } : {}),
    };

    let result: ActionResult;
    let timedOut = false;
    try {
      // Handles the model holds ("booking-1") go back to the real ids here.
      const input = withoutCallerIdReferences(this.idHandles.fromModel(args), binding.callerIdPaths[action]);
      result = forModel(await withTimeout(this.run(action, ctx, input), this.init.timeoutMs ?? CONTRACT_TOOL_TIMEOUT_MS));
    } catch (err) {
      timedOut = err instanceof ActionTimeout;
      result = timedOut ? this.timedOut(toolName, kind, lang) : actionFail('INTERNAL', 'The action could not run');
    }
    const status: ContractToolRun['status'] = timedOut ? 'timeout' : countsAsFailure(result) ? 'failed' : 'success';

    if (countsAsFailure(result) && guard.recordFailure(callId, toolName) >= guard.threshold) {
      return this.finish(action, this.stopResult(guard, toolName), status);
    }

    if (!result.ok) {
      const { error } = result;
      const asked = error.code === 'SLOT_MISSING' && error.askId && !error.exit ? binding.asks[error.askId]?.[lang] : undefined;
      return this.finish(action, asked ? { ok: false, error: { ...error, callerSafeMessage: asked } } : result, status);
    }

    const data = asRecord(result.data);
    if (kind === 'prepare' && typeof data?.confirmationToken === 'string') {
      this.proposalLanguages.set(data.confirmationToken, lang);
    }
    if (kind === 'commit') {
      const say = this.afterWrite(action, args, result.readback ?? (typeof data?.readback === 'string' ? data.readback : ''));
      const view = commitView(action, result);
      return this.finish(action, say ? { ...view, say } : view, status);
    }
    return this.finish(action, result, status);
  }

  /** The model's view of a result (internal ids swapped for handles or dropped), plus how the run ended. */
  private finish(action: string, value: unknown, status: ContractToolRun['status']): ContractToolRun {
    const view = this.idHandles.toModel(value, action, SPEAKABLE_REFS.get(action));
    const errorMessage = status === 'success' ? undefined : errorMessageOf(view);
    const ok = asRecord(value)?.ok === true;
    return { output: JSON.stringify(view), status, ok, rateLimited: false, ...(errorMessage ? { errorMessage } : {}) };
  }

  /**
   * A timed-out action, worded by its kind. A prepare or write that timed out
   * is remembered, so the stop result for that tool keeps the same wording.
   */
  private timedOut(toolName: string, kind: string | undefined, lang: TemplateLanguage): ActionResult {
    const cls = timeoutClass(kind);
    if (cls === 'read') {
      return actionFail('UPSTREAM_UNAVAILABLE', 'The action timed out. Nothing changed; it can be tried again.', {
        retryable: true,
        callerSafeMessage: READ_TIMED_OUT[lang],
      });
    }
    this.uncertainWrites.set(toolName, cls);
    return actionFail('UPSTREAM_UNAVAILABLE', WRITE_TIMED_OUT_NOTE, {
      retryable: false,
      exit: 'message_ticket',
      callerSafeMessage: this.uncertainLine(cls, lang),
    });
  }

  /** What she says about a prepare or write that timed out, in `lang`. */
  private uncertainLine(cls: Exclude<TimeoutClass, 'read'>, lang: TemplateLanguage): string {
    if (cls === 'prepare') return PREPARE_TIMED_OUT[lang];
    const smsOn = (this.init.smsEnabled ?? envSmsSendConfig.smsEnabled)();
    const followUp = smsOn ? [TEXT_OR_FOLLOW_UP[lang]] : [SHOP_WILL_CONFIRM[lang], this.init.binding.textWillFollow[lang]];
    return [STILL_CONFIRMING[lang], ...followUp, OFFER_MESSAGE[lang]].join(' ');
  }

  /**
   * ToolStopGuard's stop result. For a tool with a timed-out prepare or write
   * on this call, "could not complete it" may be untrue: the stop keeps the
   * timeout's "can't confirm yet" wording instead.
   */
  private stopResult(guard: ToolStopGuard, toolName: string): ToolStoppedResult {
    const stopped = guard.result(this.init.callId, toolName);
    const cls = this.uncertainWrites.get(toolName);
    if (!cls) return stopped;
    const line = this.uncertainLine(cls, this.language);
    return {
      ...stopped,
      message:
        `${TOOL_STOPPED_CODE}: ${toolName} is stopped for the rest of the call. An earlier attempt timed out and may still have gone through, `
        + 'so do not call it again, do not say it failed and do not offer to do it again. Say message_for_caller_hint, then offer to take a message.',
      message_for_caller_hint: line,
    };
  }

  /**
   * The commit's readback is in its proposal's language (payload.locale ??
   * ctx.locale on the server, and every proposal made here carries one), so
   * the line around it uses that language, not the call's current one. A
   * token this bridge didn't prepare has no known language: no line.
   */
  private afterWrite(action: string, args: Record<string, unknown>, readback: string): string | undefined {
    const token = typeof args.confirmationToken === 'string' ? args.confirmationToken : '';
    const lang = this.proposalLanguages.get(token);
    if (!lang) return undefined;
    return afterWriteLine(this.init.binding, action, readback, lang, (this.init.smsEnabled ?? envSmsSendConfig.smsEnabled)());
  }
}

export interface ContractToolBridgeSession {
  tenantId: string;
  callId: string;
  callerNumber?: string;
  agent: {
    agentId: string;
    timeZone: string;
    language?: string;
    contractTools?: ContractToolBinding;
  };
}

/** The bridge for a composer agent's session, or undefined for every other agent. */
export function createContractToolBridge(session: ContractToolBridgeSession): ContractToolBridge | undefined {
  const binding = session.agent.contractTools;
  if (!binding) return undefined;
  return new ContractToolBridge({
    tenantId: session.tenantId,
    callId: session.callId,
    agentId: session.agent.agentId,
    binding,
    timeZone: session.agent.timeZone,
    language: session.agent.language,
    callerNumber: session.callerNumber,
  });
}
