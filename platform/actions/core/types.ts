import type { ZodType } from 'zod';

export type ActorType = 'user' | 'agent' | 'mcp' | 'system';

export type Actor = {
  type: ActorType;
  id: string;
  role?: string;
  scopes?: string[];
};

export interface ActionContext {
  tenantId: string;
  actor: Actor;
  now: Date;
  idempotencyKey?: string;
  callId?: string;
  conversationId?: string;
  locale?: string;
  tenantTimezone: string;
}

export type ActionTool =
  | 'scheduling'
  | 'sms'
  | 'tickets'
  | 'dispatch'
  | 'orders'
  | 'business'
  | 'calls';

export type ActionKind = 'read' | 'prepare' | 'commit' | 'write';

export const ACTION_ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FORBIDDEN',
  'TOOL_NOT_ENABLED',
  'CONFLICT',
  'OUTSIDE_POLICY',
  'CONFIRMATION_REQUIRED',
  'CONFIRMATION_INVALID',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'RECIPIENT_OPTED_OUT',
  'MESSAGING_NOT_ENABLED',
  'QUIET_HOURS',
  'INVALID_NUMBER',
  'INTERNAL',
] as const;

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  callerSafeMessage: string;
  retryable: boolean;
  field?: string;
  alternatives?: unknown[];
}

export interface Effect {
  type: string;
  payload?: unknown;
}

export type ActionResult<T = unknown> =
  | { ok: true; data: T; readback?: string; effects?: Effect[] }
  | { ok: false; error: ActionError };

export interface ActionPermissions {
  roles?: string[];
  agent?: boolean;
  mcpScope?: string;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number | null;
}

export interface TenantTx {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface ActionDefinition<I = unknown, O = unknown> {
  name: string;
  tool: ActionTool;
  kind: ActionKind;
  input: ZodType<I>;
  output: ZodType<O>;
  permissions: ActionPermissions;
  agentDescription?: string;
  run: (ctx: ActionContext, input: I, tx: TenantTx) => Promise<ActionResult<O>>;
}

// Registry entries are heterogeneous; `any` keeps assignability from typed defs.
export type AnyActionDefinition = ActionDefinition<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const PROPOSAL_TTL_MS = 5 * 60 * 1000;

export function isWriteKind(kind: ActionKind): boolean {
  return kind === 'write' || kind === 'prepare' || kind === 'commit';
}
