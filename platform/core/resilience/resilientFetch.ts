import { getCircuitBreaker } from './circuitBreakerRegistry';
import { withRetry } from './retry';
import { withTimeout } from './timeout';
import { withResiliency } from './index';
import { CircuitOpenError } from './circuitBreaker';
import { OPENAI_RETRY_CONFIG } from './presets';
import type { RetryOptions } from './types';

/**
 * Drop-in fetch replacement with circuit breaker + retry + timeout.
 */
export async function resilientFetch(
  url: string,
  options: RequestInit,
  config: {
    circuitName: string;
    retryOptions?: Partial<RetryOptions>;
    timeoutMs?: number;
    context?: string;
  },
): Promise<Response> {
  const circuitBreaker = getCircuitBreaker(config.circuitName);
  const retryOpts: RetryOptions = {
    ...OPENAI_RETRY_CONFIG,
    ...config.retryOptions,
  };

  const operation = async () => {
    const fetchPromise = fetch(url, options);
    const response = config.timeoutMs
      ? await withTimeout(fetchPromise, config.timeoutMs, config.context)
      : await fetchPromise;

    if (!response.ok && response.status >= 500) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  };

  const result = await withResiliency(operation, circuitBreaker, retryOpts, config.context);

  if (!result.success) {
    throw result.error;
  }

  return result.result!;
}
