import type { RetryOptions, CircuitBreakerOptions } from './types';

export const OPENAI_RETRY_CONFIG: RetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 200,
  maxDelayMs: 3000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
  retryableErrors: (error) => {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('timed out')) return true;
      if (msg.includes('econnreset') || msg.includes('econnrefused')) return true;
      if (msg.includes('503') || msg.includes('502') || msg.includes('500')) return true;
    }
    return false;
  },
};

export const TWILIO_RETRY_CONFIG: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.15,
  retryableErrors: (error) => {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('rate limit') || msg.includes('429')) return true;
      if (msg.includes('timeout')) return true;
      if (msg.includes('503') || msg.includes('502')) return true;
    }
    return false;
  },
};

export const TICKETING_RETRY_CONFIG: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 2000,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

export const OPENAI_CIRCUIT_CONFIG: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  halfOpenMaxAttempts: 2,
};

export const TWILIO_CIRCUIT_CONFIG: CircuitBreakerOptions = {
  failureThreshold: 3,
  resetTimeoutMs: 60000,
  halfOpenMaxAttempts: 1,
};

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
};
