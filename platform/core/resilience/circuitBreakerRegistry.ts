import { CircuitBreaker } from './circuitBreaker';
import type { CircuitBreakerOptions, CircuitState } from './types';
import {
  OPENAI_CIRCUIT_CONFIG,
  TWILIO_CIRCUIT_CONFIG,
  DEFAULT_CIRCUIT_CONFIG,
} from './presets';

const registry = new Map<string, CircuitBreaker>();

function resolveDefaultOptions(name: string): CircuitBreakerOptions {
  const lower = name.toLowerCase();
  if (lower.includes('openai')) return OPENAI_CIRCUIT_CONFIG;
  if (lower.includes('twilio')) return TWILIO_CIRCUIT_CONFIG;
  return DEFAULT_CIRCUIT_CONFIG;
}

/**
 * Get or create a named circuit breaker.
 * Name convention: `<tenantId>:<integrationName>` for tenant-scoped breakers,
 * or `platform:<integrationName>` for shared platform breakers.
 */
export function getCircuitBreaker(
  name: string,
  options?: CircuitBreakerOptions,
): CircuitBreaker {
  if (!registry.has(name)) {
    registry.set(name, new CircuitBreaker(name, options ?? resolveDefaultOptions(name)));
  }
  return registry.get(name)!;
}

export function getCircuitBreakerMetrics(): Record<
  string,
  { state: CircuitState; failureCount: number; lastFailureTime: number }
> {
  const metrics: Record<
    string,
    { state: CircuitState; failureCount: number; lastFailureTime: number }
  > = {};
  for (const [name, breaker] of registry) {
    metrics[name] = breaker.getMetrics();
  }
  return metrics;
}
