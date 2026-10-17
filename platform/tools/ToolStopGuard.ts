/**
 * Repeated-tool stop (VA-06 tool ceiling, hard signal only).
 *
 * Counts every executed attempt of a tool that failed in one call, including
 * RetryOrchestrator retries. Once a tool reaches the threshold (3), later
 * attempts of that tool in that call do not execute: executeWithRetry returns
 * `stopped: true` and the caller hands the model `toolStoppedResult()`.
 * Counters are keyed by callId + tool name and cleared when the call ends.
 * Independent of the reasoning mode.
 */

export const TOOL_STOP_THRESHOLD = 3;
export const TOOL_STOPPED_CODE = 'TOOL_STOPPED';

/** What the agent may say. No time promise (Oct 17 hiccup 5). */
export const TOOL_STOPPED_CALLER_HINT =
  "I'm sorry, I wasn't able to complete that. I can have the shop follow up with you about it.";

export interface ToolStoppedResult {
  ok: false;
  success: false;
  code: typeof TOOL_STOPPED_CODE;
  retryable: false;
  tool: string;
  failedAttempts: number;
  message: string;
  message_for_caller_hint: string;
}

export function toolStoppedResult(toolName: string, failedAttempts: number): ToolStoppedResult {
  return {
    ok: false,
    success: false,
    code: TOOL_STOPPED_CODE,
    retryable: false,
    tool: toolName,
    failedAttempts,
    message:
      `${TOOL_STOPPED_CODE}: ${toolName} failed ${failedAttempts} times on this call and is stopped for the rest of the call. ` +
      'Do not call it again. Tell the caller plainly that you could not complete it, and offer to have the shop follow up ' +
      '(a callback or a message). Do not promise a time.',
    message_for_caller_hint: TOOL_STOPPED_CALLER_HINT,
  };
}

export function isToolStoppedResult(value: unknown): value is ToolStoppedResult {
  return Boolean(value && typeof value === 'object' && (value as { code?: unknown }).code === TOOL_STOPPED_CODE);
}

export class ToolStopGuard {
  private readonly failures = new Map<string, Map<string, number>>();

  constructor(readonly threshold: number = TOOL_STOP_THRESHOLD) {}

  failureCount(callId: string, toolName: string): number {
    return this.failures.get(callId)?.get(toolName) ?? 0;
  }

  isStopped(callId: string, toolName: string): boolean {
    return Boolean(callId) && this.failureCount(callId, toolName) >= this.threshold;
  }

  /** Record one executed attempt that failed. Returns the call's count for the tool. */
  recordFailure(callId: string, toolName: string): number {
    if (!callId) return 0;
    const perCall = this.failures.get(callId) ?? new Map<string, number>();
    const count = (perCall.get(toolName) ?? 0) + 1;
    perCall.set(toolName, count);
    this.failures.set(callId, perCall);
    return count;
  }

  result(callId: string, toolName: string): ToolStoppedResult {
    return toolStoppedResult(toolName, this.failureCount(callId, toolName));
  }

  clearCall(callId: string): void {
    this.failures.delete(callId);
  }

  trackedCallCount(): number {
    return this.failures.size;
  }
}

/** Process-wide guard the voice tool handler uses. */
export const toolStopGuard = new ToolStopGuard();
