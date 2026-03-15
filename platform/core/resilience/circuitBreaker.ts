import type { CircuitBreakerOptions, CircuitState } from './types';

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(circuitName: string, retryAfterMs: number) {
    super(
      `Circuit breaker '${circuitName}' is open. Retry after ${Math.round(retryAfterMs / 1000)}s`,
    );
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Circuit breaker with closed / open / half-open state machine.
 * Instantiated per integration endpoint; managed via CircuitBreakerRegistry.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  constructor(
    private readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.options.resetTimeoutMs) {
        this.transitionTo('half-open');
      } else {
        throw new CircuitOpenError(this.name, this.options.resetTimeoutMs - elapsed);
      }
    }

    if (this.state === 'half-open') {
      if (this.halfOpenAttempts >= (this.options.halfOpenMaxAttempts ?? 1)) {
        throw new CircuitOpenError(this.name, this.options.resetTimeoutMs);
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.transitionTo('closed');
    }
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.transitionTo('open');
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.transitionTo('open');
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'closed') {
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
    }

    this.options.onStateChange?.(oldState, newState);
    console.info(`[CIRCUIT ${this.name}] ${oldState} → ${newState}`);
  }

  getState(): CircuitState {
    return this.state;
  }

  getMetrics(): { state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  reset(): void {
    this.transitionTo('closed');
    console.info(`[CIRCUIT ${this.name}] Manually reset`);
  }
}
