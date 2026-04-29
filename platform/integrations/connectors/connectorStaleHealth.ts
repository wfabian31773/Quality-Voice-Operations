import type { ConnectorTokenHealthRow } from './db';

/**
 * Shared definitions for the "stale connector" computation used by both:
 *   - the Platform Admin Connector Health route (`platformConnectorHealth.ts`)
 *   - the proactive `ConnectorStaleAlertScheduler`
 *
 * Keeping the constants and the `computeStaleConnector` predicate in one
 * module guarantees the on-screen badge in the admin UI and the off-hours
 * email digest agree on what counts as "stale". Drift between the two would
 * be confusing — ops would either get paged for connectors the UI shows as
 * healthy, or open the page after a digest and see nothing flagged.
 */

/**
 * Mirror of `OAuthTokenRefreshScheduler.CHECK_INTERVAL_MS`. We intentionally
 * keep a local copy instead of importing from the scheduler module so this
 * file (and the route that imports it) doesn't transitively pull in the
 * scheduler's `setInterval` side effects.
 */
export const REFRESH_CYCLE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Window inside which we treat a still-valid token as "expiring soon" for
 * the green/yellow/red badge. Matches the OAuth scheduler's refresh
 * horizon.
 */
export const TOKEN_EXPIRING_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Number of sweep cycles past expiry (or past the `needs_reconnect`
 * transition) before we badge a connector as "stale" — i.e. the worker
 * should have rotated this token by now but hasn't. 2 cycles ≈ 30 min of
 * missed refreshes.
 */
export const STALE_CYCLE_THRESHOLD = 2;

export type TokenHealthStatus =
  | 'healthy'
  | 'expiring'
  | 'expired'
  | 'needs_reconnect'
  | 'unknown';

export function computeTokenHealthStatus(
  lastSyncStatus: string | null,
  expiresInMs: number | null,
): TokenHealthStatus {
  if (lastSyncStatus === 'needs_reconnect') return 'needs_reconnect';
  if (expiresInMs === null) return 'unknown';
  if (expiresInMs <= 0) return 'expired';
  if (expiresInMs <= TOKEN_EXPIRING_HORIZON_MS) return 'expiring';
  return 'healthy';
}

export interface StaleEvaluation {
  status: TokenHealthStatus;
  /** Milliseconds until the token expires (negative when expired). Null when unknown. */
  expiresInMs: number | null;
  /**
   * Whole sweep cycles since the worker last successfully refreshed (or
   * since the token expired, when no issued_at is available). Null when we
   * cannot reason about the cycle count.
   */
  cyclesSinceRefresh: number | null;
  /**
   * True when the connector is `expired` or `needs_reconnect` and has been
   * past that point for at least `STALE_CYCLE_THRESHOLD` sweep cycles.
   * Stable connectors (`healthy`, `expiring`, `unknown`) and recent
   * failures (just transitioned, < threshold) return false.
   */
  stale: boolean;
}

/**
 * Stale predicate shared by the Connector Health route and the new
 * `ConnectorStaleAlertScheduler`. Pulled out so both call sites apply
 * identical thresholds — see file-level comment.
 *
 * `nowMs` is injected so callers (and tests) can pin time without monkey-
 * patching `Date.now`. The route passes `Date.now()`; the scheduler does
 * the same and tests pass deterministic timestamps.
 */
export function computeStaleEvaluation(
  row: Pick<
    ConnectorTokenHealthRow,
    'lastSyncStatus' | 'lastSyncErrorAt' | 'tokenIssuedAt' | 'tokenExpiresAt'
  >,
  nowMs: number,
): StaleEvaluation {
  const expiresInMs = row.tokenExpiresAt !== null ? row.tokenExpiresAt - nowMs : null;
  const status = computeTokenHealthStatus(row.lastSyncStatus, expiresInMs);

  let cyclesSinceRefresh: number | null = null;
  if (row.tokenIssuedAt !== null) {
    const ageMs = nowMs - row.tokenIssuedAt;
    cyclesSinceRefresh = Math.max(0, Math.floor(ageMs / REFRESH_CYCLE_INTERVAL_MS));
  } else if (expiresInMs !== null && expiresInMs < 0) {
    cyclesSinceRefresh = Math.floor(-expiresInMs / REFRESH_CYCLE_INTERVAL_MS);
  }

  let stale = false;
  if (status === 'needs_reconnect') {
    if (row.lastSyncErrorAt) {
      const errAgeMs = nowMs - Date.parse(row.lastSyncErrorAt);
      if (
        Number.isFinite(errAgeMs)
        && errAgeMs >= STALE_CYCLE_THRESHOLD * REFRESH_CYCLE_INTERVAL_MS
      ) {
        stale = true;
      }
    }
  } else if (status === 'expired') {
    if (
      expiresInMs !== null
      && -expiresInMs >= STALE_CYCLE_THRESHOLD * REFRESH_CYCLE_INTERVAL_MS
    ) {
      stale = true;
    }
  }

  return { status, expiresInMs, cyclesSinceRefresh, stale };
}
