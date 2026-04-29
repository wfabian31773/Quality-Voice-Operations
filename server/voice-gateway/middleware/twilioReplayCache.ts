/**
 * Replay-protection cache for Twilio webhooks (task #942).
 *
 * Twilio's `X-Twilio-Signature` is HMAC-SHA1(authToken, URL + sorted-form-params).
 * The signature does NOT bind a timestamp, so a captured (URL, params, signature)
 * tuple verifies forever — exactly the replay class of bug we patched on Cal.com
 * (task #430).
 *
 * Defense model
 * -------------
 * Cal.com signs a `t=<unix>` timestamp into the webhook envelope, which lets
 * us reject any payload older than ±5 minutes. Twilio gives us no equivalent
 * field, so we instead treat each provider-issued unique ID
 * (`MessageSid`, `CallSid`, `MessageSid+MessageStatus`,
 * `CallSid+SequenceNumber`) as a one-shot nonce inside a fixed window.
 *
 * The cache TTL IS the replay window. We default it to **300 seconds (5 min)**
 * to match the Cal.com / Stripe semantics — a captured payload re-fired more
 * than 5 minutes later is treated as "stale" by the same yardstick those
 * providers use, even though we can't verify staleness cryptographically.
 * The window is overridable via `TWILIO_REPLAY_WINDOW_SECONDS` for ops to
 * tune (e.g. lengthen during an incident) without a code change.
 *
 * Two-layer storage
 * -----------------
 * Lookups go through two layers:
 *   1. An in-memory LRU+TTL cache, fast-path on the same process.
 *   2. A durable PostgreSQL table (`twilio_webhook_replay_nonces`, created in
 *      migrations/100_twilio_webhook_replay_nonces.sql) for cross-instance
 *      and cross-restart durability. The Postgres write is a single
 *      `INSERT ... ON CONFLICT (nonce) DO UPDATE ... WHERE expires_at <= NOW()
 *      RETURNING (xmax = 0) AS inserted`, so the result tells us atomically
 *      whether we won the race AND whether the existing row had already
 *      expired (in which case we reclaim it — outside the TTL window the
 *      same nonce is allowed again, mirroring the Cal.com / Stripe
 *      replay-window semantics). Concurrent gateway instances cannot both
 *      treat the same captured payload as fresh.
 *
 * Pruning
 * -------
 * Each successful claim has a small (~0.5%) chance of running a single
 * `DELETE ... WHERE expires_at <= NOW()` opportunistically and out-of-band
 * (we don't await it, so latency is unaffected). That keeps the table
 * bounded on busy deployments without depending on an external cron. For
 * very low-traffic deployments, ops can also run a scheduled job — the
 * `idx_twilio_webhook_replay_nonces_expires_at` index makes either prune
 * cheap.
 *
 * If the durable layer is unavailable (no platform pool, or a transient DB
 * error), we fall back to the in-memory layer and log loudly. This is
 * fail-open at the durable tier but fail-closed at the in-memory tier — the
 * alternative (rejecting every webhook on a DB blip) would take voice down
 * for far less benefit than it costs.
 *
 * Twilio retry behavior
 * ---------------------
 *   - Voice webhooks: retried at most once on transport-layer / 11200-class
 *     errors. We mark the nonce after signature verification succeeds, so a
 *     retry that re-arrives within the TTL would be rejected as a replay —
 *     this is an accepted trade-off because Twilio voice retries are extremely
 *     rare in practice and the replay-defense win is more important.
 *   - Voice status callbacks: each fire carries a distinct `SequenceNumber`,
 *     so legitimate per-event status callbacks key uniquely.
 *   - SMS-status callbacks: each transition (`queued`/`sent`/`delivered`/
 *     `failed`/`undelivered`) carries a distinct `MessageStatus`, so
 *     legitimate lifecycle progression keys uniquely.
 *   - SMS inbound: each delivery has a fresh `MessageSid`.
 */

import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('TWILIO_REPLAY_CACHE');

const DEFAULT_TTL_SECONDS = 300; // 5 minutes — matches Cal.com / Stripe replay windows
const DEFAULT_MAX_ENTRIES = 10_000;

function readEnvSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

interface Entry {
  expiresAt: number;
}

// `Map` preserves insertion order, which we exploit for cheap LRU-style
// eviction when we exceed `maxEntries`.
const seen = new Map<string, Entry>();

function nowMs(): number {
  return Date.now();
}

function ttlSeconds(): number {
  return readEnvSeconds('TWILIO_REPLAY_WINDOW_SECONDS', DEFAULT_TTL_SECONDS);
}

function ttlMs(): number {
  return ttlSeconds() * 1000;
}

function maxEntries(): number {
  return readEnvInt('TWILIO_REPLAY_CACHE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES);
}

function pruneExpired(now: number): void {
  // Bounded-cost prune: scan from oldest (insertion order) and stop on the
  // first non-expired entry. Touched entries are re-inserted so they sort to
  // the back of the iteration order (see `markSeen`).
  for (const [key, entry] of seen) {
    if (entry.expiresAt > now) break;
    seen.delete(key);
  }
}

function evictIfFull(): void {
  const cap = maxEntries();
  while (seen.size > cap) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

interface DurableBackend {
  // Atomically claims the nonce. Returns true if this caller is the first to
  // see the nonce (fresh), false if another instance / process / earlier
  // request already claimed it within the TTL (replay).
  claim(key: string, expiresAtMs: number): Promise<boolean>;
}

let durableBackend: DurableBackend | null | undefined;

// Probability that a successful claim also runs an opportunistic prune of
// expired rows. ~1/200 keeps DB load negligible (≈0.5% extra DELETE per
// write) while ensuring even sparse-traffic deployments eventually reclaim
// dormant expired nonces without depending on an external cron.
const OPPORTUNISTIC_PRUNE_PROBABILITY = 1 / 200;

function defaultDurableBackend(): DurableBackend | null {
  // Lazy require so test environments without a platform DB pool can still
  // exercise the cache (in-memory only). We swallow any setup error and fall
  // back to in-memory — see file-header notes on the fail-open trade-off.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPlatformPool } = require('../../../platform/db');
    const pool = getPlatformPool?.();
    if (!pool || typeof pool.query !== 'function') return null;
    return {
      async claim(key: string, expiresAtMs: number): Promise<boolean> {
        // TTL-aware atomic claim. Three outcomes from a single statement:
        //   (a) Row didn't exist → INSERT runs → RETURNING yields the row,
        //       and `xmax = 0` (no prior tuple) is true ⇒ fresh.
        //   (b) Row existed but its `expires_at <= NOW()` → ON CONFLICT
        //       DO UPDATE runs (gated by the WHERE) → RETURNING yields the
        //       row, `xmax = 0` is false ⇒ also fresh (we successfully
        //       reclaimed an expired nonce, which is the intended TTL
        //       semantics — outside the 5-min window the same nonce is
        //       allowed again, mirroring Cal.com / Stripe).
        //   (c) Row existed and is still inside its TTL → ON CONFLICT
        //       DO UPDATE's WHERE filters it out → RETURNING is empty
        //       (rowCount = 0) ⇒ replay.
        // The whole thing is one statement, so it's atomic with respect to
        // concurrent gateway instances racing on the same nonce.
        const expiresIso = new Date(expiresAtMs).toISOString();
        const result = await pool.query(
          `INSERT INTO twilio_webhook_replay_nonces (nonce, expires_at)
           VALUES ($1, $2::timestamptz)
           ON CONFLICT (nonce) DO UPDATE
             SET expires_at = EXCLUDED.expires_at
             WHERE twilio_webhook_replay_nonces.expires_at <= NOW()
           RETURNING (xmax = 0) AS inserted`,
          [key, expiresIso],
        );
        const fresh = (result.rowCount ?? 0) > 0;

        // Opportunistic prune: keep the table from accumulating dormant
        // expired rows that no future webhook will ever reclaim. Done
        // out-of-band (we don't await the result) so it never adds latency
        // to the webhook response.
        if (fresh && Math.random() < OPPORTUNISTIC_PRUNE_PROBABILITY) {
          pool
            .query('DELETE FROM twilio_webhook_replay_nonces WHERE expires_at <= NOW()')
            .catch((err: unknown) => {
              logger.warn('Opportunistic prune of replay nonces failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }

        return fresh;
      },
    };
  } catch (err) {
    logger.warn('Durable replay backend unavailable — falling back to in-memory cache only', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function getDurableBackend(): DurableBackend | null {
  if (durableBackend === undefined) {
    durableBackend = defaultDurableBackend();
  }
  return durableBackend;
}

/**
 * Test hook: install (or remove) a durable backend. Production code should
 * never call this — production picks up the Postgres-backed default lazily.
 */
export function __setTwilioReplayDurableBackendForTests(
  backend: DurableBackend | null,
): void {
  durableBackend = backend;
}

/**
 * Returns true if the given nonce has been seen within the active TTL window
 * (and is therefore a replay), checking both the in-memory cache and the
 * durable Postgres store. The check-and-claim is atomic on the Postgres side
 * via `INSERT ... ON CONFLICT`, so concurrent gateway instances cannot both
 * treat the same captured payload as fresh.
 *
 * Side-effect: when the nonce is fresh, this function ALSO claims it (in
 * both layers). Callers must therefore treat a `false` return as "you've now
 * marked this nonce as seen — don't call markSeen again". The legacy
 * `markSeen` export is kept as a no-op alias for backwards compatibility
 * inside this module.
 */
export async function isReplay(key: string): Promise<boolean> {
  if (!key) return false;
  const now = nowMs();

  // Fast in-memory check. If we have a non-expired entry, this is a replay
  // without us needing to touch Postgres.
  const entry = seen.get(key);
  if (entry) {
    if (entry.expiresAt > now) return true;
    seen.delete(key);
  }

  const expiresAt = now + ttlMs();
  const backend = getDurableBackend();

  if (backend) {
    let durableSaysFresh = false;
    try {
      durableSaysFresh = await backend.claim(key, expiresAt);
    } catch (err) {
      // DB blip — fail open at the durable tier (still safe at the in-memory
      // tier within this process). Logged loudly so ops can correlate with
      // any spike in `replay_detected` rejections.
      logger.warn('Durable replay store query failed — falling back to in-memory check only', {
        error: err instanceof Error ? err.message : String(err),
      });
      durableSaysFresh = true;
    }
    if (!durableSaysFresh) {
      // Another instance/process already claimed this nonce. Mirror it into
      // our local cache so subsequent in-process replays short-circuit
      // without another DB roundtrip.
      pruneExpired(now);
      seen.delete(key);
      seen.set(key, { expiresAt });
      evictIfFull();
      return true;
    }
  }

  // Fresh — claim in-memory.
  pruneExpired(now);
  seen.delete(key);
  seen.set(key, { expiresAt });
  evictIfFull();
  return false;
}

/**
 * Backwards-compatible no-op. `isReplay` now does the claim atomically, so
 * the historical `markSeen()` call after `isReplay()` is unnecessary. Kept
 * exported so any out-of-tree callers don't break.
 */
export function markSeen(_key: string): void {
  // Intentionally a no-op — see isReplay() for the actual claim logic.
}

/**
 * Build the per-route nonce from a Twilio webhook body. Returns null when the
 * payload doesn't carry an identifier we can use (in which case the caller
 * should not enforce replay detection for that route — the signature check
 * still applies).
 */
export function deriveNonce(routePath: string, body: Record<string, unknown>): string | null {
  const get = (k: string): string | null => {
    const v = body?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
  };

  // Normalize the path. The check order matters: `/twilio/sms-status` matches
  // BOTH `/sms` and `/status` substrings, so the more specific routes have to
  // be classified first. Picking the wrong bucket here is a functional bug:
  //   * SMS status callbacks for one MessageSid fire multiple times
  //     (`queued` → `sent` → `delivered`/`failed`); keying by `MessageSid`
  //     alone (the `/sms` bucket) would reject every legitimate transition
  //     after the first as a replay.
  //   * Voice status callbacks for one CallSid likewise fan out per event;
  //     keying by `CallSid` alone (the `/voice` bucket) would do the same.
  const path = routePath.toLowerCase();

  if (path.includes('/sms-status')) {
    // SMS lifecycle: dedupe by MessageSid + MessageStatus so each transition
    // (queued/sent/delivered/failed/undelivered) passes once but a verbatim
    // replay of any single transition is rejected.
    const sid = get('MessageSid') ?? get('SmsSid');
    if (!sid) return null;
    const status = get('MessageStatus') ?? get('SmsStatus') ?? 'unknown';
    return `sms-status:${sid}:${status}`;
  }
  if (path.includes('/status')) {
    // Voice status callbacks. SequenceNumber is monotonic per call; falling
    // back to CallStatus keeps dedupe useful if Twilio omits SequenceNumber.
    const callSid = get('CallSid');
    if (!callSid) return null;
    const seq = get('SequenceNumber') ?? get('CallStatus') ?? 'unknown';
    return `status:${callSid}:${seq}`;
  }
  if (path.includes('/sms')) {
    const sid = get('MessageSid') ?? get('SmsSid');
    return sid ? `sms:${sid}` : null;
  }
  if (path.includes('/voice') || path.includes('/outbound')) {
    const callSid = get('CallSid');
    return callSid ? `call:${callSid}` : null;
  }
  // Unknown route under the Twilio mount — best-effort key off the most
  // distinctive identifiers we've seen so signature-only protection still has
  // a replay layer.
  const sid = get('CallSid') ?? get('MessageSid');
  return sid ? `twilio:${sid}` : null;
}

export function __resetTwilioReplayCacheForTests(): void {
  seen.clear();
  // Force the lazy backend to re-resolve on the next call so tests can swap
  // in a fake by calling __setTwilioReplayDurableBackendForTests().
  durableBackend = undefined;
}

export function __getTwilioReplayCacheSizeForTests(): number {
  return seen.size;
}
