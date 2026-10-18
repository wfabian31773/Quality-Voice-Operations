import type { ActionErrorCode, ActionResult, Effect } from './types';

const RETRYABLE: ReadonlySet<ActionErrorCode> = new Set([
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL',
]);

const GENERIC_SAFE: Record<ActionErrorCode, string> = {
  VALIDATION_FAILED: 'Some details are missing or invalid.',
  NOT_FOUND: "I couldn't find that.",
  FORBIDDEN: "I don't have permission to do that.",
  TOOL_NOT_ENABLED: "That isn't available for this business.",
  CONFLICT: 'That time or record is no longer available.',
  OUTSIDE_POLICY: "That isn't allowed by the shop's policy.",
  CONFIRMATION_REQUIRED: 'Please confirm before I continue.',
  CONFIRMATION_INVALID: 'That confirmation is no longer valid. I can start over.',
  IDEMPOTENCY_KEY_REUSED: 'This request does not match the original. I can start over.',
  RATE_LIMITED: 'Please wait a moment and try again.',
  UPSTREAM_UNAVAILABLE: 'A downstream service is unavailable. Please try again shortly.',
  RECIPIENT_OPTED_OUT: "I can't text this number.",
  MESSAGING_NOT_ENABLED: "Texting isn't set up for this business yet.",
  QUIET_HOURS: "You'll get the text in the morning.",
  INVALID_NUMBER: "That number can't receive texts.",
  SLOT_MISSING: 'I need one more detail first.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
};

export function actionOk<T>(
  data: T,
  extras?: { readback?: string; effects?: Effect[] },
): ActionResult<T> {
  return {
    ok: true,
    data,
    ...(extras?.readback ? { readback: extras.readback } : {}),
    ...(extras?.effects ? { effects: extras.effects } : {}),
  };
}

export function actionFail(
  code: ActionErrorCode,
  message: string,
  opts?: {
    field?: string;
    alternatives?: unknown[];
    retryable?: boolean;
    callerSafeMessage?: string;
    askId?: string;
    exit?: 'message_ticket';
  },
): ActionResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      callerSafeMessage: opts?.callerSafeMessage ?? GENERIC_SAFE[code],
      retryable: opts?.retryable ?? RETRYABLE.has(code),
      ...(opts?.field ? { field: opts.field } : {}),
      ...(opts?.alternatives ? { alternatives: opts.alternatives } : {}),
      ...(opts?.askId ? { askId: opts.askId } : {}),
      ...(opts?.exit ? { exit: opts.exit } : {}),
    },
  };
}

export function isActionFailure(value: unknown): value is ActionResult<never> {
  return typeof value === 'object' && value !== null && (value as ActionResult).ok === false;
}

export function internalError(cause: unknown): ActionResult<never> {
  const message = cause instanceof Error ? cause.message : String(cause);
  return actionFail('INTERNAL', message, {
    callerSafeMessage: GENERIC_SAFE.INTERNAL,
    retryable: true,
  });
}
