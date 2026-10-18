import { createHash } from 'node:crypto';
import { actionFail } from './errors';
import { zodToJsonSchema } from './jsonSchema';
import { runActionDefinition, type ActionRuntime } from './runAction';
import type { ActionContext, ActionDefinition, ActionErrorCode, ActionResult, Actor } from './types';

export const OPENAI_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface AgentToolSchema {
  name: string;
  actionName: string;
  description: string;
  agentDescription: string;
  parameters: Record<string, unknown>;
}

export interface ExternalToolNames {
  toExternal: Map<string, string>;
  toAction: Map<string, string>;
}

/** OpenAI-safe form of an action name. Dots and other punctuation become `_`. */
export function sanitizeExternalToolName(actionName: string): string {
  const cleaned = actionName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const base = cleaned.length > 0 ? cleaned : 'action';
  return base.slice(0, 64);
}

function hashedExternalName(actionName: string, used: Set<string>): string {
  const digest = createHash('sha256').update(actionName).digest('hex').slice(0, 8);
  const prefix = sanitizeExternalToolName(actionName).slice(0, 55);
  let candidate = `${prefix}_${digest}`.slice(0, 64);
  let n = 0;
  while (used.has(candidate) || !OPENAI_TOOL_NAME.test(candidate)) {
    n += 1;
    candidate = `${prefix}_${digest}${n}`.slice(0, 64);
  }
  return candidate;
}

/** Deterministic, collision-checked external names plus a reverse dispatch map. */
export function assignExternalToolNames(actionNames: Iterable<string>): ExternalToolNames {
  const toExternal = new Map<string, string>();
  const toAction = new Map<string, string>();
  const used = new Set<string>();
  for (const actionName of [...actionNames].sort()) {
    let candidate = sanitizeExternalToolName(actionName);
    if (used.has(candidate)) candidate = hashedExternalName(actionName, used);
    used.add(candidate);
    toExternal.set(actionName, candidate);
    toAction.set(candidate, actionName);
  }
  return { toExternal, toAction };
}

export function actionNameFromExternal(external: string, names: ExternalToolNames): string | undefined {
  return names.toAction.get(external);
}

export function toAgentToolSchema<I, O>(
  def: ActionDefinition<I, O>,
  names?: ExternalToolNames,
): AgentToolSchema {
  const agentDescription = def.agentDescription ?? def.name;
  const name = names?.toExternal.get(def.name) ?? sanitizeExternalToolName(def.name);
  return {
    name,
    actionName: def.name,
    description: agentDescription,
    agentDescription,
    parameters: zodToJsonSchema(def.input),
  };
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

export function toMcpTool<I, O>(def: ActionDefinition<I, O>): McpToolSchema {
  return {
    name: def.name,
    description: def.agentDescription ?? def.name,
    inputSchema: zodToJsonSchema(def.input),
    annotations: {
      readOnlyHint: def.kind === 'read',
      destructiveHint: def.kind === 'write' || def.kind === 'commit',
      openWorldHint: false,
    },
  };
}

export const HTTP_STATUS_BY_ERROR: Record<ActionErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  TOOL_NOT_ENABLED: 403,
  CONFLICT: 409,
  OUTSIDE_POLICY: 422,
  CONFIRMATION_REQUIRED: 409,
  CONFIRMATION_INVALID: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  RECIPIENT_OPTED_OUT: 422,
  MESSAGING_NOT_ENABLED: 403,
  QUIET_HOURS: 202,
  INVALID_NUMBER: 400,
  SLOT_MISSING: 422,
  INTERNAL: 500,
};

export interface ActionHttpRequest {
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
  tenantId: string;
  actor: Actor;
  callId?: string;
  conversationId?: string;
  locale?: string;
  tenantTimezone: string;
  now?: Date;
}

export interface ActionHttpResponse {
  status: number;
  body: ActionResult;
  headers?: Record<string, string>;
}

function header(headers: ActionHttpRequest['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== needle) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

export function httpStatusFor(result: ActionResult): number {
  if (result.ok) return 200;
  return HTTP_STATUS_BY_ERROR[result.error.code] ?? 500;
}

/** HTTP callers only see caller-safe INTERNAL text, never exception details. */
export function publicHttpResult(result: ActionResult): ActionResult {
  if (result.ok || result.error.code !== 'INTERNAL') return result;
  return {
    ok: false,
    error: {
      ...result.error,
      message: result.error.callerSafeMessage,
    },
  };
}

export function toHttpHandler<I, O>(def: ActionDefinition<I, O>, runtime?: ActionRuntime) {
  return async (req: ActionHttpRequest): Promise<ActionHttpResponse> => {
    if (!req.tenantId) {
      const body = actionFail('VALIDATION_FAILED', 'tenantId is required', { field: 'tenantId' });
      return { status: 400, body };
    }
    const ctx: ActionContext = {
      tenantId: req.tenantId,
      actor: req.actor,
      now: req.now ?? new Date(),
      idempotencyKey: header(req.headers, 'idempotency-key'),
      callId: req.callId,
      conversationId: req.conversationId,
      locale: req.locale,
      tenantTimezone: req.tenantTimezone,
    };
    const body = publicHttpResult(await runActionDefinition(def, ctx, req.body, runtime));
    return { status: httpStatusFor(body), body };
  };
}
