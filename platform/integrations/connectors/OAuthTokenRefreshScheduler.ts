import { createLogger } from '../../core/logger';
import {
  ensureFreshOAuthToken,
  getRefreshableProviders,
  isRefreshableProvider,
} from './tokenRefresh';
import { listRefreshableConnectorConfigs } from './db';

const logger = createLogger('OAUTH_TOKEN_REFRESH_SCHEDULER');

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;
// Per audit BL-022 / I-05: pre-refresh any token expiring within 24h. For
// short-TTL providers (~1h) this still effectively means "every cycle", but
// the lifetime-fraction guard below prevents us from hammering provider
// token endpoints when a token was just refreshed.
const REFRESH_HORIZON_MS = 24 * 60 * 60 * 1000;
// Refresh once we have consumed at least this fraction of the original
// token lifetime. Combined with the horizon check, this means short-TTL
// (~1h) tokens get refreshed roughly halfway through their life and
// long-TTL (>24h) tokens get refreshed when they enter the 24h window.
const REFRESH_LIFETIME_FRACTION = 0.5;
// Hard floor: always refresh when the token is closer to expiry than this,
// regardless of the lifetime fraction (covers tokens with very short TTLs
// or where token_issued_at was never persisted).
const REFRESH_FLOOR_MS = 5 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let cycleInFlight = false;

export interface OAuthTokenRefreshCycleResult {
  scanned: number;
  expiringSoon: number;
  refreshed: number;
  failed: number;
  skippedNoRefreshToken: number;
}

/**
 * Sweep all enabled connectors for refreshable OAuth providers and proactively
 * refresh any whose `token_expires_at` falls within the configured horizon.
 *
 * Failures still flow through `markConnectorReconnectNeeded` + audit log
 * inside `ensureFreshOAuthToken`; this function just logs and counts them.
 */
export async function runOAuthTokenRefreshCycle(
  horizonMs: number = REFRESH_HORIZON_MS,
): Promise<OAuthTokenRefreshCycleResult> {
  const result: OAuthTokenRefreshCycleResult = {
    scanned: 0,
    expiringSoon: 0,
    refreshed: 0,
    failed: 0,
    skippedNoRefreshToken: 0,
  };

  const configs = await listRefreshableConnectorConfigs(getRefreshableProviders());
  result.scanned = configs.length;
  const now = Date.now();
  const cutoff = now + horizonMs;

  for (const config of configs) {
    if (!isRefreshableProvider(config.provider)) continue;
    const expiresAtRaw = config.credentials.token_expires_at;
    if (!expiresAtRaw) continue;
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt)) continue;
    if (expiresAt > cutoff) continue;

    // If we know when this token was issued, only refresh once we've
    // consumed at least half of its lifetime. This stops 24h-horizon
    // sweeps from rotating short-TTL tokens on every cycle. Tokens
    // without a persisted issued_at (legacy / pre-tracking) fall through
    // to the simple horizon check.
    const issuedAtRaw = config.credentials.token_issued_at;
    if (issuedAtRaw) {
      const issuedAt = Number(issuedAtRaw);
      if (Number.isFinite(issuedAt) && issuedAt < expiresAt) {
        const lifetime = expiresAt - issuedAt;
        const remaining = expiresAt - now;
        const consumedFraction = (lifetime - remaining) / lifetime;
        if (
          consumedFraction < REFRESH_LIFETIME_FRACTION
          && remaining > REFRESH_FLOOR_MS
        ) {
          continue;
        }
      }
    }

    result.expiringSoon += 1;

    if (!config.credentials.refresh_token) {
      result.skippedNoRefreshToken += 1;
    }

    try {
      await ensureFreshOAuthToken(config, { leadMs: horizonMs });
      result.refreshed += 1;
      logger.info('Proactively refreshed OAuth token', {
        tenantId: config.tenantId,
        integrationId: config.integrationId,
        provider: config.provider,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (err) {
      result.failed += 1;
      logger.warn('Proactive OAuth token refresh failed', {
        tenantId: config.tenantId,
        integrationId: config.integrationId,
        provider: config.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.expiringSoon > 0) {
    logger.info('OAuth token refresh cycle complete', { ...result });
  } else {
    logger.debug('OAuth token refresh cycle complete (no tokens due)', { ...result });
  }

  return result;
}

async function safeRunCycle(): Promise<void> {
  if (cycleInFlight) {
    logger.warn('Skipping OAuth token refresh cycle — previous cycle still running');
    return;
  }
  cycleInFlight = true;
  try {
    await runOAuthTokenRefreshCycle();
  } catch (err) {
    logger.error('OAuth token refresh cycle threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cycleInFlight = false;
  }
}

export function startOAuthTokenRefreshScheduler(
  intervalMs: number = CHECK_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    void safeRunCycle();
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    void safeRunCycle();
  }, intervalMs);

  logger.info('OAuth token refresh scheduler started', {
    intervalMs,
    horizonMs: REFRESH_HORIZON_MS,
    providers: getRefreshableProviders(),
  });
}

export function stopOAuthTokenRefreshScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('OAuth token refresh scheduler stopped');
  }
}
