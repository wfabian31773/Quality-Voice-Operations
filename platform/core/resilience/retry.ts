import type { RetryOptions, RetryResult } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async operation with exponential backoff retry.
 * Generic and integration-agnostic — configure via RetryOptions.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  context?: string,
): Promise<RetryResult<T>> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier = 2,
    jitterFactor = 0.1,
    retryableErrors = () => true,
    onRetry,
  } = options;

  const startTime = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();
      return {
        success: true,
        result,
        attempts: attempt,
        totalTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error;

      const isRetryable = retryableErrors(error);
      const hasMoreAttempts = attempt < maxAttempts;

      if (!isRetryable || !hasMoreAttempts) {
        if (context) {
          console.error(`[RESILIENCE] ${context} failed after ${attempt} attempt(s):`, error);
        }
        return {
          success: false,
          error: lastError,
          attempts: attempt,
          totalTimeMs: Date.now() - startTime,
        };
      }

      const baseDelay = Math.min(
        initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs,
      );
      const jitter = baseDelay * jitterFactor * (Math.random() * 2 - 1);
      const delayMs = Math.round(baseDelay + jitter);

      if (onRetry) {
        onRetry(attempt, error, delayMs);
      } else if (context) {
        console.warn(
          `[RESILIENCE] ${context} attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`,
        );
      }

      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: maxAttempts,
    totalTimeMs: Date.now() - startTime,
  };
}
