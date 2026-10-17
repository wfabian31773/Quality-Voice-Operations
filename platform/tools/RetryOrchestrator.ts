import { EventEmitter } from 'events';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';
import type { ToolStopGuard } from './ToolStopGuard';

const logger = createLogger('RETRY_ORCHESTRATOR');

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  timeoutMs: 15000,
  backoffMultiplier: 2,
};

export interface ToolFailureEvent {
  tenantId: TenantId;
  toolName: string;
  callSessionId: string;
  agentSlug?: string;
  error: string;
  retryCount: number;
  maxRetries: number;
  timestamp: Date;
  finalFailure: boolean;
  fallbackAttempted: boolean;
  fallbackSuccess: boolean;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: string;
  attempts: number;
  totalDurationMs: number;
  usedFallback: boolean;
  /**
   * The stop guard stopped this tool for the call (TOOL_STOP_THRESHOLD failed
   * tool calls). `attempts` counts only the attempts this call executed.
   */
  stopped?: boolean;
}

type ToolExecutor<T> = () => Promise<T>;
type FallbackExecutor<T> = () => Promise<T>;

class RetryOrchestratorEmitter extends EventEmitter {}

const emitter = new RetryOrchestratorEmitter();

export function onToolFailure(handler: (event: ToolFailureEvent) => void): void {
  emitter.on('tool-failure', handler);
}

export function removeToolFailureListener(handler: (event: ToolFailureEvent) => void): void {
  emitter.removeListener('tool-failure', handler);
}

/**
 * A tool failure that will fail the same way on every attempt (bad SQL,
 * constraint or validation failure, a policy block). executeWithRetry
 * stops after the first attempt instead of adding seconds of dead air.
 */
export class NonRetryableToolError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableToolError';
  }
}

// Transient SQLSTATEs: serialization failure, deadlock, admin shutdown,
// crash shutdown, cannot connect now. Classes 08 (connection) and 53
// (insufficient resources) are transient as a whole.
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '57P01', '57P02', '57P03']);
const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '53']);
// Deterministic classes: 22 data exception, 23 integrity constraint
// violation, 42 syntax error or access rule (e.g. 42P18, 42804).
const DETERMINISTIC_SQLSTATE_CLASSES = new Set(['22', '23', '42']);

/** true / false for a known SQLSTATE class, undefined when it says nothing. */
export function isRetryableSqlState(code: unknown): boolean | undefined {
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return undefined;
  if (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2))) return true;
  if (DETERMINISTIC_SQLSTATE_CLASSES.has(code.slice(0, 2))) return false;
  return undefined;
}

/**
 * Whether a tool failure is worth another attempt. Takes a thrown error or
 * a `{ success: false, retryable?, code? }` tool result. An explicit
 * `retryable` flag wins, then a Postgres SQLSTATE `code`. Anything else
 * (timeouts, connection resets, unknown errors) keeps the retry.
 */
export function isRetryableToolError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const { retryable, code } = err as { retryable?: unknown; code?: unknown };
    if (typeof retryable === 'boolean') return retryable;
    const bySqlState = isRetryableSqlState(code);
    if (bySqlState !== undefined) return bySqlState;
  }
  return true;
}

function computeDelay(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const jitter = Math.random() * config.baseDelayMs * 0.5;
  return Math.min(delay + jitter, config.maxDelayMs);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithRetry<T>(
  executor: ToolExecutor<T>,
  context: {
    tenantId: TenantId;
    toolName: string;
    callSessionId: string;
    agentSlug?: string;
    retryConfig?: Partial<RetryConfig>;
    fallbackExecutor?: FallbackExecutor<T>;
    /**
     * Repeated-tool stop: an invocation that ends in failure counts once
     * toward the call's limit for this tool (retries inside it don't add
     * more); once stopped, later invocations run nothing.
     */
    stopGuard?: ToolStopGuard;
  },
): Promise<RetryResult<T>> {
  const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...context.retryConfig };
  const startTime = Date.now();
  const guard = context.stopGuard;
  let lastError = '';
  let attemptsMade = 0;

  if (guard?.isStopped(context.callSessionId, context.toolName)) {
    // Stopped earlier in this call: no attempt, no tool-failure event, no fallback.
    return {
      success: false,
      error: `TOOL_STOPPED: ${context.toolName} is stopped for this call`,
      attempts: 0,
      totalDurationMs: Date.now() - startTime,
      usedFallback: false,
      stopped: true,
    };
  }

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    attemptsMade = attempt + 1;
    try {
      const result = await withTimeout(executor(), config.timeoutMs);
      return {
        success: true,
        result,
        attempts: attempt + 1,
        totalDurationMs: Date.now() - startTime,
        usedFallback: false,
      };
    } catch (err) {
      lastError = String(err);
      logger.warn('Tool execution attempt failed', {
        tenantId: context.tenantId,
        tool: context.toolName,
        callId: context.callSessionId,
        attempt: attempt + 1,
        maxRetries: config.maxRetries,
        error: lastError,
      });

      if (!isRetryableToolError(err)) {
        logger.info('Tool failure is not retryable; failing fast', {
          tenantId: context.tenantId,
          tool: context.toolName,
          callId: context.callSessionId,
          attempt: attempt + 1,
        });
        break;
      }

      if (attempt < config.maxRetries) {
        emitter.emit('tool-failure', {
          tenantId: context.tenantId,
          toolName: context.toolName,
          callSessionId: context.callSessionId,
          agentSlug: context.agentSlug,
          error: lastError,
          retryCount: attempt + 1,
          maxRetries: config.maxRetries,
          timestamp: new Date(),
          finalFailure: false,
          fallbackAttempted: false,
          fallbackSuccess: false,
        } as ToolFailureEvent);

        const delay = computeDelay(attempt, config);
        await sleep(delay);
      }
    }
  }

  let fallbackAttempted = false;
  let fallbackSuccess = false;

  if (context.fallbackExecutor) {
    fallbackAttempted = true;
    try {
      logger.info('Attempting fallback executor', {
        tenantId: context.tenantId,
        tool: context.toolName,
        callId: context.callSessionId,
      });
      const fallbackResult = await withTimeout(context.fallbackExecutor(), config.timeoutMs);
      fallbackSuccess = true;

      emitter.emit('tool-failure', {
        tenantId: context.tenantId,
        toolName: context.toolName,
        callSessionId: context.callSessionId,
        agentSlug: context.agentSlug,
        error: lastError,
        retryCount: attemptsMade,
        maxRetries: config.maxRetries,
        timestamp: new Date(),
        finalFailure: false,
        fallbackAttempted: true,
        fallbackSuccess: true,
      } as ToolFailureEvent);

      return {
        success: true,
        result: fallbackResult,
        attempts: attemptsMade + 1,
        totalDurationMs: Date.now() - startTime,
        usedFallback: true,
      };
    } catch (fallbackErr) {
      lastError = String(fallbackErr);
      logger.error('Fallback executor also failed', {
        tenantId: context.tenantId,
        tool: context.toolName,
        callId: context.callSessionId,
        error: lastError,
      });
    }
  }

  // This invocation failed: one failure toward the call's limit.
  let stopped = false;
  if (guard) {
    guard.recordFailure(context.callSessionId, context.toolName);
    stopped = guard.isStopped(context.callSessionId, context.toolName);
    if (stopped) {
      logger.warn('Tool stopped for this call after repeated failures', {
        tenantId: context.tenantId,
        tool: context.toolName,
        callId: context.callSessionId,
        failedCalls: guard.failureCount(context.callSessionId, context.toolName),
      });
    }
  }

  const failureEvent: ToolFailureEvent = {
    tenantId: context.tenantId,
    toolName: context.toolName,
    callSessionId: context.callSessionId,
    agentSlug: context.agentSlug,
    error: lastError,
    retryCount: attemptsMade,
    maxRetries: config.maxRetries,
    timestamp: new Date(),
    finalFailure: true,
    fallbackAttempted,
    fallbackSuccess,
  };
  emitter.emit('tool-failure', failureEvent);

  return {
    success: false,
    error: lastError,
    attempts: attemptsMade + (fallbackAttempted ? 1 : 0),
    totalDurationMs: Date.now() - startTime,
    usedFallback: fallbackAttempted,
    ...(stopped ? { stopped: true } : {}),
  };
}

const toolRetryConfigs = new Map<string, Partial<RetryConfig>>();

export function setToolRetryConfig(toolName: string, config: Partial<RetryConfig>): void {
  toolRetryConfigs.set(toolName, config);
}

export function getToolRetryConfig(toolName: string): RetryConfig {
  const override = toolRetryConfigs.get(toolName);
  return { ...DEFAULT_RETRY_CONFIG, ...override };
}

export function clearToolRetryConfig(toolName: string): void {
  toolRetryConfigs.delete(toolName);
}
