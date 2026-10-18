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
 */
import { randomUUID } from 'node:crypto';
import { afterWriteLine, type ContractToolBinding } from '../../../platform/agent-runtime/composer';
import { templateLanguage, type TemplateLanguage } from '../../../platform/agent-templates/shared';
import { actionFail, getAction, runAction, type ActionContext, type ActionResult } from '../../../platform/actions';
import { envSmsSendConfig } from '../../../platform/actions/sms/deps';
import { isCallerIdReference } from '../../../platform/reasoning/sessionBinding';

/** Production runs platform/actions' runAction; tests inject a fake. */
export type ContractActionRunner = (name: string, ctx: ActionContext, input: unknown) => Promise<ActionResult>;

/** The language note the runtime's record_language_change tool takes. */
const LANGUAGE_TOOL = 'record_language_change';

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
      result = forModel(await this.run(action, ctx, withoutCallerIdReferences(args, binding.callerIdPaths[action])));
    } catch {
      result = actionFail('INTERNAL', 'The action could not run');
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
