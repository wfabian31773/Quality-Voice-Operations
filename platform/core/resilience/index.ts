export * from './types';
export * from './presets';
export * from './retry';
export * from './circuitBreaker';
export * from './circuitBreakerRegistry';
export * from './timeout';
export * from './resilientFetch';

import { withRetry } from './retry';
import { CircuitBreaker, CircuitOpenError } from './circuitBreaker';
import type { RetryOptions, RetryResult } from './types';

/**
 * Execute an operation with both retry logic and circuit breaker protection.
 * CircuitOpenError is never retried — it is a fast-fail signal.
 */
export async function withResiliency<T>(
  operation: () => Promise<T>,
  circuitBreaker: CircuitBreaker,
  retryOptions: RetryOptions,
  context?: string,
): Promise<RetryResult<T>> {
  return withRetry(
    () => circuitBreaker.execute(operation),
    {
      ...retryOptions,
      retryableErrors: (error) => {
        if (error instanceof CircuitOpenError) return false;
        return retryOptions.retryableErrors?.(error) ?? true;
      },
    },
    context,
  );
}
