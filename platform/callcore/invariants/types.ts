/**
 * Types for the runtime invariant checker (D3). Pure data: no I/O, no clock,
 * no randomness. Mirrors the action kinds in platform/actions without
 * importing them, so this folder stays self-contained.
 */

/** Kind of a tool the model asks to run. `transfer` is the runtime's own transfer tool. */
export type ActionKind = 'read' | 'write' | 'prepare' | 'commit' | 'transfer';

/** A side-effecting tool result the call has seen (commit, write or transfer). */
export interface CommittedResult {
  readonly action: string;
  readonly kind: 'write' | 'commit' | 'transfer';
  readonly ok: boolean;
  /** Refs the tool returned (booking ref, ticket number). Never caller input. */
  readonly refs: readonly string[];
}

export interface CallFacts {
  readonly callId: string;
  /** The caller has been heard (transcribed) at least once. */
  readonly heard: boolean;
  readonly transferNumberConfigured: boolean;
  /** False: refs are texted, never spoken. */
  readonly voiceRefs: boolean;
  readonly smsEnabled: boolean;
  readonly committed: readonly CommittedResult[];
  /** Confirmation tokens returned by a prepare on this call and not yet committed. */
  readonly preparedTokens: ReadonlySet<string>;
  /** Token the caller explicitly said yes to after its readback. */
  readonly explicitYesForToken?: string;
  /** The floor (file-a-message-if-nothing-filed) check has run for this call. */
  readonly floorEvaluated: boolean;
  /** A tool result came back and the agent hasn't spoken since. */
  readonly unvoicedToolResult: boolean;
  /** Actions named by the agent's selected contracts. */
  readonly allowedActions: readonly string[];
}

export interface CallFactsInit {
  callId: string;
  transferNumberConfigured: boolean;
  voiceRefs: boolean;
  smsEnabled: boolean;
  allowedActions: readonly string[];
}

export interface ToolResultInput {
  action: string;
  kind: ActionKind;
  ok: boolean;
  refs?: readonly string[];
  /** The token a commit consumed; an ok commit retires it. */
  confirmationToken?: string;
}

export interface RunRequest {
  action: string;
  kind: ActionKind;
  confirmationToken?: string;
  args?: unknown;
}

/** One finished tool run, most recent last. The caller keeps it short (see appendRun). */
export interface RunRecord {
  readonly action: string;
  readonly kind: ActionKind;
  readonly ok: boolean;
  /** normalizeArgs(args) */
  readonly argsKey: string;
}

/** Why the runtime wants to end the call. */
export type EndReason = 'agent_goodbye' | 'silence' | 'max_duration' | 'never_heard';

export type RuleId =
  | 'run.action_not_allowed'
  | 'run.commit_without_token'
  | 'run.commit_token_not_prepared'
  | 'run.commit_without_yes'
  | 'run.success_run_ceiling'
  | 'say.stage_direction'
  | 'say.ref_not_voiced'
  | 'say.ref_not_committed'
  | 'say.success_before_commit'
  | 'say.transfer_without_result'
  | 'say.text_promise_sms_off'
  | 'transfer.no_number'
  | 'end.unvoiced_tool_result'
  | 'end.floor_not_evaluated';

export type CheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: RuleId; readonly instruction: string };
