import { EventEmitter } from 'events';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

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
  },
): Promise<RetryResult<T>> {
  const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...context.retryConfig };
  const startTime = Date.now();
  let lastError = '';

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
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
        retryCount: config.maxRetries + 1,
        maxRetries: config.maxRetries,
        timestamp: new Date(),
        finalFailure: false,
        fallbackAttempted: true,
        fallbackSuccess: true,
      } as ToolFailureEvent);

      return {
        success: true,
        result: fallbackResult,
        attempts: config.maxRetries + 2,
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

  const failureEvent: ToolFailureEvent = {
    tenantId: context.tenantId,
    toolName: context.toolName,
    callSessionId: context.callSessionId,
    agentSlug: context.agentSlug,
    error: lastError,
    retryCount: config.maxRetries + 1,
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
    attempts: config.maxRetries + 1 + (fallbackAttempted ? 1 : 0),
    totalDurationMs: Date.now() - startTime,
    usedFallback: fallbackAttempted,
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
