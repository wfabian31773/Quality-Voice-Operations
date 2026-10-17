/**
 * Repeated-tool stop (VA-06 tool ceiling, hard signal only).
 *
 * Counts failed tool calls in one call: one executeWithRetry invocation that
 * ends in failure counts once, however many RetryOrchestrator retries it
 * ran. Once a tool reaches the threshold (3), later calls of that tool in
 * that call do not execute: executeWithRetry returns `stopped: true` and the
 * caller hands the model `toolStoppedResult()`. Counters are keyed by
 * callId + tool name and cleared when the call ends. Independent of the
 * reasoning mode.
 *
 * Parallel calls of the same tool can each pass `isStopped` before any of
 * them records a failure, so a tool can run a little past the threshold.
 * That is accepted.
 */

export const TOOL_STOP_THRESHOLD = 3;
/** Recently cleared call ids remembered so a late failure can't recreate the entry. */
const CLOSED_CALLS_LIMIT = 1000;
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
  private readonly closedCalls = new Set<string>();

  constructor(
    readonly threshold: number = TOOL_STOP_THRESHOLD,
    private readonly closedCallsLimit: number = CLOSED_CALLS_LIMIT,
  ) {}

  failureCount(callId: string, toolName: string): number {
    return this.failures.get(callId)?.get(toolName) ?? 0;
  }

  isStopped(callId: string, toolName: string): boolean {
    return Boolean(callId) && this.failureCount(callId, toolName) >= this.threshold;
  }

  /**
   * Record one failed tool call. Returns the call's count for the tool. A
   * failure landing after clearCall (hangup mid-tool) is ignored.
   */
  recordFailure(callId: string, toolName: string): number {
    if (!callId || this.closedCalls.has(callId)) return 0;
    const perCall = this.failures.get(callId) ?? new Map<string, number>();
    const count = (perCall.get(toolName) ?? 0) + 1;
    perCall.set(toolName, count);
    this.failures.set(callId, perCall);
    return count;
  }

  result(callId: string, toolName: string): ToolStoppedResult {
    return toolStoppedResult(toolName, this.failureCount(callId, toolName));
  }

  /** A call (re)starts: failures are recorded for it again. */
  openCall(callId: string): void {
    this.closedCalls.delete(callId);
  }

  clearCall(callId: string): void {
    this.failures.delete(callId);
    if (!callId) return;
    this.closedCalls.delete(callId);
    this.closedCalls.add(callId);
    if (this.closedCalls.size > this.closedCallsLimit) {
      const oldest = this.closedCalls.values().next().value;
      if (oldest !== undefined) this.closedCalls.delete(oldest);
    }
  }

  trackedCallCount(): number {
    return this.failures.size;
  }
}

/** Process-wide guard the voice tool handler uses. */
export const toolStopGuard = new ToolStopGuard();
