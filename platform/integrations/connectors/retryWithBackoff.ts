import { createLogger } from '../../core/logger';

const logger = createLogger('CONNECTOR_RETRY');

/**
 * BL-014: shared retry-with-backoff helper for connector adapters
 * (HubSpot, Salesforce, Pipedrive, Slack, Zapier, Zoho).
 *
 * The default schedule is 3 attempts at 1s / 4s / 16s with ±20% jitter,
 * which keeps total latency under the 60s adapter budget specified in
 * BL-014. Callers can pass a `Retry-After` value (e.g. parsed from a 429
 * response) to override the next sleep; the helper caps every wait at
 * `maxBackoffMs` (default 30s) so a hostile upstream cannot stretch a
 * single dispatch past the adapter latency budget.
 */

export interface RetryOptions {
  /**
   * Maximum number of attempts INCLUDING the first one. With the default
   * value of 3 the call sequence is: try → sleep → try → sleep → try.
   */
  maxAttempts?: number;
  /** Base delays per attempt-after-failure in ms. */
  baseDelaysMs?: number[];
  /** Cap any single wait (jitter / Retry-After / base delay) at this value. */
  maxBackoffMs?: number;
  /** ±jitter as a fraction of the base delay (e.g. 0.2 → ±20%). */
  jitterRatio?: number;
  /** Decide whether to retry given the thrown error. Default: retry on Error. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject jitter for tests. Receives the base delay, returns the actual delay. */
  jitter?: (baseMs: number) => number;
  /** Optional label included in retry logs. */
  label?: string;
}

const DEFAULT_DELAYS_MS = [1_000, 4_000, 16_000];
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyJitter(baseMs: number, ratio: number): number {
  if (ratio <= 0) return baseMs;
  // Symmetric jitter in [-ratio, +ratio] of the base delay.
  const delta = (Math.random() * 2 - 1) * ratio * baseMs;
  return Math.max(0, Math.round(baseMs + delta));
}

function clamp(ms: number, max: number): number {
  return Math.min(ms, max);
}

/**
 * Generic retry helper. Runs `fn`; on rejection, calls `shouldRetry` to
 * decide; if true, sleeps the next base delay (with jitter, clamped to
 * `maxBackoffMs`) and retries up to `maxAttempts` total.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelays = opts.baseDelaysMs ?? DEFAULT_DELAYS_MS;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const shouldRetry =
    opts.shouldRetry ??
    ((err: unknown) => err instanceof Error || typeof err === 'string');
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitter ?? ((base: number) => applyJitter(base, jitterRatio));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLast = attempt >= maxAttempts;
      if (isLast || !shouldRetry(err, attempt)) {
        throw err;
      }
      const baseDelay = baseDelays[Math.min(attempt - 1, baseDelays.length - 1)] ?? 1_000;
      const delay = clamp(jitter(baseDelay), maxBackoff);
      if (opts.label) {
        logger.warn('retrying after error', {
          label: opts.label,
          attempt,
          nextDelayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(delay);
    }
  }
  // Unreachable in practice — the loop either returns or throws.
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* retryFetch                                                          */
/* ------------------------------------------------------------------ */

export interface RetryFetchOptions extends RetryOptions {
  /** Custom fetcher (e.g. an SSRF-guarded fetch). Default: global fetch. */
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Statuses that trigger a retry. Default: 429, 502, 503, 504. */
  retryStatuses?: number[];
  /**
   * If true (default), respect the `Retry-After` response header on 429/503
   * by overriding the next sleep with the recommended interval (still
   * clamped to `maxBackoffMs`).
   */
  honorRetryAfter?: boolean;
  /**
   * Hard wall-clock budget for the entire retry sequence (including all
   * sleeps and Retry-After waits). Default 60_000ms = 60s, matching the
   * BL-014 adapter latency budget. When the deadline is reached:
   *   - the next sleep is shortened so it cannot exceed the remaining
   *     budget; and
   *   - any subsequent failure short-circuits to `return last response`
   *     rather than triggering another retry.
   */
  maxTotalMs?: number;
}

const DEFAULT_RETRY_STATUSES = [429, 502, 503, 504];
const DEFAULT_MAX_TOTAL_MS = 60_000;

/**
 * Default predicate for `retryFetch` thrown errors (i.e. when the fetcher
 * itself rejects rather than returning a response). We deliberately retry
 * ONLY on classes that are clearly transient at the transport layer and
 * never on domain exceptions like SSRF/policy errors:
 *   - AbortError: a per-attempt request timeout (the adapter's own
 *     AbortController fired). Retrying may succeed on a fresh connection.
 *   - TypeError "fetch failed" / common ECONN/ETIMEDOUT/ENOTFOUND: Node's
 *     undici-based fetch wraps network errors as TypeError. Retrying is
 *     the entire point of this helper.
 * Everything else (incl. SsrfBlockedError, validation errors, programmer
 * errors) MUST be surfaced unchanged.
 */
function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  if (err instanceof TypeError) {
    const msg = err.message ?? '';
    return /fetch failed|network|socket|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg);
  }
  return false;
}

class RetryFetchHttpError extends Error {
  status: number;
  retryAfterMs: number | null;
  response: Response;
  constructor(response: Response, retryAfterMs: number | null) {
    super(`HTTP ${response.status}`);
    this.name = 'RetryFetchHttpError';
    this.status = response.status;
    this.retryAfterMs = retryAfterMs;
    this.response = response;
  }
}

/**
 * Parse a `Retry-After` header value. Per RFC 7231 it is either delta-seconds
 * (e.g. `"5"`) or an HTTP-date (e.g. `"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns the delay in milliseconds, or null if the header is absent /
 * unparseable / negative.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  // delta-seconds
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1_000);
  }

  // HTTP-date — require recognisable date markers (a comma, a colon, or
  // a month abbreviation) so accidental numeric / negative inputs do not
  // get coerced via Date.parse's lenient implementation.
  if (!/[,:]/.test(trimmed) && !/[A-Za-z]{3}/.test(trimmed)) return null;
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  const delta = ts - now;
  return delta > 0 ? delta : 0;
}

/**
 * Fetch wrapper that retries on transient failures (network errors and
 * configurable retry statuses) with backoff. On 429 / 503 with a
 * `Retry-After` header, the next sleep uses the recommended interval
 * (clamped to `maxBackoffMs`). Non-retryable responses (e.g. 4xx other
 * than 429) are returned to the caller as-is so they can do their own
 * status-based handling.
 */
export async function retryFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: RetryFetchOptions = {},
): Promise<Response> {
  const fetcher = opts.fetcher ?? ((globalThis.fetch as typeof fetch).bind(globalThis));
  const retryStatuses = new Set(opts.retryStatuses ?? DEFAULT_RETRY_STATUSES);
  const honorRetryAfter = opts.honorRetryAfter ?? true;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxTotalMs = opts.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;

  // Per-dispatch deadline: total wall-clock for *all* retry sleeps + the
  // remaining Retry-After header values must stay inside `maxTotalMs`.
  // We measure from the moment retryFetch is invoked so the budget covers
  // the inflight request that ultimately fails as well.
  const startedAt = Date.now();
  const remainingMs = (): number => Math.max(0, maxTotalMs - (Date.now() - startedAt));

  const shouldRetry = (err: unknown, attempt: number): boolean => {
    // Hard cut-off: once the per-dispatch deadline is reached we never
    // start another retry, no matter how cheap the next sleep would be.
    if (remainingMs() <= 0) return false;

    if (err instanceof RetryFetchHttpError) {
      return retryStatuses.has(err.status);
    }
    // Allow callers to override the transient-error policy if they need to
    // (e.g. a synthetic test-only error class). The default is intentionally
    // conservative — we only retry classes we KNOW are safe to retry.
    if (opts.shouldRetry) return opts.shouldRetry(err, attempt);
    return isTransientFetchError(err);
  };

  // The wrapped retryWithBackoff schedule, with a custom sleep that
  // honors Retry-After when the failure is a retryable HTTP error and
  // caps every wait at the *remaining* per-dispatch budget so a hostile
  // upstream cannot stretch the dispatch past `maxTotalMs`.
  let nextOverrideMs: number | null = null;
  const baseSleep = opts.sleep ?? defaultSleep;
  const wrappedSleep = async (delayMs: number) => {
    const requested =
      nextOverrideMs != null ? clamp(nextOverrideMs, maxBackoff) : delayMs;
    nextOverrideMs = null;
    // Cap every wait at the remaining budget. If the budget is exhausted
    // we skip the sleep entirely; the next iteration's `shouldRetry` will
    // see `remainingMs() === 0` and refuse to retry, returning the final
    // response unchanged.
    const effective = Math.min(requested, remainingMs());
    if (effective <= 0) return;
    await baseSleep(effective);
  };

  // Track the most recent retryable HTTP error so that, if the
  // per-dispatch deadline expires during a sleep OR during the final
  // in-flight fetch, we can surface the last response to the caller
  // rather than throwing.
  let lastHttpError: RetryFetchHttpError | null = null;

  /**
   * Race the fetcher against the per-dispatch deadline so wall-clock
   * cannot exceed `maxTotalMs` even if a single request hangs for its
   * full per-attempt timeout. The orphaned fetch remains in flight and
   * will resolve in the background — that is acceptable because the
   * caller has already given up on the dispatch by then.
   */
  const fetcherRaceDeadline = async (): Promise<Response> => {
    const remaining = remainingMs();
    // Hard floor of 1ms to ensure setTimeout actually schedules.
    const deadlineMs = Math.max(1, remaining);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadlinePromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e: Error & { name: string } = new Error(
          'retryFetch dispatch deadline exceeded',
        );
        e.name = 'RetryFetchDeadlineExceeded';
        reject(e);
      }, deadlineMs);
    });
    try {
      return await Promise.race([fetcher(input, init), deadlinePromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return retryWithBackoff(
    async (_attempt) => {
      // Attempt-boundary deadline guard. If the budget was exhausted
      // (during a sleep, a prior in-flight fetch, or anywhere else) we
      // must NOT issue another outbound request — that fetch could take
      // up to its per-attempt timeout and push the dispatch well past
      // `maxTotalMs`, and even routing through the deadline race below
      // would still call `fetcher(...)` exactly once. Short-circuit
      // synchronously: surface `lastHttpError` if we have one (so the
      // outer `.catch` returns the prior response) or throw a deadline
      // error if the very first attempt was already too late.
      if (remainingMs() <= 0) {
        if (lastHttpError) throw lastHttpError;
        const e: Error & { name: string } = new Error(
          'retryFetch dispatch deadline exceeded',
        );
        e.name = 'RetryFetchDeadlineExceeded';
        throw e;
      }
      let res: Response;
      try {
        res = await fetcherRaceDeadline();
      } catch (err) {
        // Deadline tripped mid-fetch. If we already saw a retryable HTTP
        // error on a prior attempt, surface that response to the caller
        // (consistent with status-exhaustion semantics) — otherwise let
        // the deadline error propagate so the caller can see what went
        // wrong on a hung first request.
        if (
          err instanceof Error &&
          err.name === 'RetryFetchDeadlineExceeded' &&
          lastHttpError
        ) {
          throw lastHttpError;
        }
        throw err;
      }
      if (retryStatuses.has(res.status)) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = honorRetryAfter ? parseRetryAfter(retryAfterHeader) : null;
        // Drain the body so the connection can be released; we only care
        // about the status + Retry-After here.
        try {
          await res.clone().text();
        } catch {
          /* ignore */
        }
        nextOverrideMs = retryAfterMs;
        const httpErr = new RetryFetchHttpError(res, retryAfterMs);
        lastHttpError = httpErr;
        throw httpErr;
      }
      return res;
    },
    {
      ...opts,
      shouldRetry,
      sleep: wrappedSleep,
    },
  ).catch((err) => {
    // Final failure: if it was a retryable HTTP status, return the response
    // so callers can do their own status-based reporting (consistent with
    // current adapter behaviour). Real network errors still propagate.
    if (err instanceof RetryFetchHttpError) return err.response;
    throw err;
  });
}

export { RetryFetchHttpError };
