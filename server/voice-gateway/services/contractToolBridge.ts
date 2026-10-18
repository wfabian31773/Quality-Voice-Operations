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
 * - each action run is cut off after the legacy per-attempt timeout (15s) and
 *   comes back as a failure that offers a message, so the caller is never
 *   left in dead air (the silence watchdog is paused during a tool run);
 * - the repeated-tool stop: once a tool has failed TOOL_STOP_THRESHOLD times
 *   in the call, it returns ToolStopGuard's stop result and no longer runs.
 *   SLOT_MISSING is an ask with its own ceiling (the contract's exit), so it
 *   doesn't count;
 * - the per-tenant tool rate limit (unifiedToolRegistry.checkRateLimit).
 */
import { randomUUID } from 'node:crypto';
import { afterWriteLine, type ContractToolBinding } from '../../../platform/agent-runtime/composer';
import { templateLanguage, type Phrase, type TemplateLanguage } from '../../../platform/agent-templates/shared';
import { actionFail, getAction, runAction, type ActionContext, type ActionResult } from '../../../platform/actions';
import { envSmsSendConfig } from '../../../platform/actions/sms/deps';
import { isCallerIdReference } from '../../../platform/reasoning/sessionBinding';
import { DEFAULT_RETRY_CONFIG } from '../../../platform/tools/RetryOrchestrator';
import { unifiedToolRegistry } from '../../../platform/tools/ToolRegistry';
import { toolStopGuard, type ToolStopGuard } from '../../../platform/tools/ToolStopGuard';

/** Production runs platform/actions' runAction; tests inject a fake. */
export type ContractActionRunner = (name: string, ctx: ActionContext, input: unknown) => Promise<ActionResult>;

/** The language note the runtime's record_language_change tool takes. */
const LANGUAGE_TOOL = 'record_language_change';

/** The per-attempt timeout legacy tools get (RetryOrchestrator's withTimeout, DEFAULT_RETRY_CONFIG.timeoutMs). */
export const CONTRACT_TOOL_TIMEOUT_MS = DEFAULT_RETRY_CONFIG.timeoutMs;

/** What the agent says when an action timed out. "Couldn't confirm": a timed-out commit may still land. */
const TIMED_OUT: Phrase = {
  en: "I'm sorry, I couldn't get that confirmed just now. I can take a message so they can follow up with you.",
  es: 'Disculpe, no pude confirmarlo en este momento. Puedo tomar un mensaje para que le den seguimiento.',
};

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
    const { binding } = this.init;
    const action = hasOwn(binding.actions, toolName) ? binding.actions[toolName] : undefined;
    if (!action) return JSON.stringify(actionFail('NOT_FOUND', `Not a contract tool: ${toolName}`));
    const guard = this.init.stopGuard ?? toolStopGuard;
    const { callId } = this.init;
    if (guard.isStopped(callId, toolName)) return JSON.stringify(guard.result(callId, toolName));
    const withinLimit = this.init.checkRateLimit ?? ((tenantId, name) => unifiedToolRegistry.checkRateLimit(tenantId, name));
    if (!withinLimit(this.init.tenantId, toolName)) {
      return JSON.stringify(actionFail('RATE_LIMITED', 'Rate limit exceeded for this tool. Please wait a moment before trying again.'));
    }

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
    try {
      const run = this.run(action, ctx, withoutCallerIdReferences(args, binding.callerIdPaths[action]));
      result = forModel(await withTimeout(run, this.init.timeoutMs ?? CONTRACT_TOOL_TIMEOUT_MS));
    } catch (err) {
      result = err instanceof ActionTimeout
        ? actionFail('UPSTREAM_UNAVAILABLE', 'The action timed out', { retryable: false, exit: 'message_ticket', callerSafeMessage: TIMED_OUT[lang] })
        : actionFail('INTERNAL', 'The action could not run');
    }

    if (countsAsFailure(result) && guard.recordFailure(callId, toolName) >= guard.threshold) {
      return JSON.stringify(guard.result(callId, toolName));
    }

    if (!result.ok) {
      const { error } = result;
      const asked = error.code === 'SLOT_MISSING' && error.askId && !error.exit ? binding.asks[error.askId]?.[lang] : undefined;
      return JSON.stringify(asked ? { ok: false, error: { ...error, callerSafeMessage: asked } } : result);
    }

    const data = asRecord(result.data);
    if (kind === 'prepare' && typeof data?.confirmationToken === 'string') {
      this.proposalLanguages.set(data.confirmationToken, lang);
    }
    if (kind === 'commit') {
      const say = this.afterWrite(action, args, result.readback ?? (typeof data?.readback === 'string' ? data.readback : ''));
      if (say) return JSON.stringify({ ...result, say });
    }
    return JSON.stringify(result);
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
