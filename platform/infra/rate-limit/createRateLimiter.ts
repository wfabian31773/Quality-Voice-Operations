import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  firstRequest: number;
  lastRequest: number;
}

export interface RateLimiterConfig {
  windowMs: number;
  maxRequests: number;
  message?: string;
  /** Return the rate-limit key for a request. Defaults to `tenantId:ip`. */
  keyGenerator?: (req: Request) => string;
}

export interface RateLimitCheckerConfig {
  windowMs: number;
  maxRequests: number;
}

export function createRateLimitChecker(config: RateLimitCheckerConfig) {
  const { windowMs, maxRequests } = config;
  const store = new Map<string, RateLimitEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.firstRequest > windowMs + 60_000) store.delete(key);
    }
  }, 60_000);

  return (key: string): boolean => {
    const now = Date.now();
    let entry = store.get(key);
    if (!entry || now - entry.firstRequest > windowMs) {
      entry = { count: 1, firstRequest: now, lastRequest: now };
      store.set(key, entry);
      return true;
    }
    entry.count++;
    entry.lastRequest = now;
    return entry.count <= maxRequests;
  };
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.socket?.remoteAddress ?? 'unknown';
}

function getTenantId(req: Request): string {
  return (req as Request & { tenantId?: string }).tenantId ?? 'platform';
}

const CLEANUP_INTERVAL_MS = 60_000;
const ENTRY_TTL_MS = 300_000;

/**
 * Create a sliding-window rate limiter middleware.
 *
 * Multi-tenant: the default key includes the tenant ID so limits are per-tenant,
 * not shared across the platform.
 */
export function createRateLimiter(config: RateLimiterConfig) {
  const {
    windowMs,
    maxRequests,
    message = 'Too many requests, please try again later.',
    keyGenerator = (req) => `${getTenantId(req)}:${getClientIp(req)}`,
  } = config;

  const store = new Map<string, RateLimitEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.firstRequest > ENTRY_TTL_MS) store.delete(key);
    }
  }, CLEANUP_INTERVAL_MS);

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator(req);
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now - entry.firstRequest > windowMs) {
      entry = { count: 1, firstRequest: now, lastRequest: now };
      store.set(key, entry);
    } else {
      entry.count++;
      entry.lastRequest = now;
    }

    const remaining = Math.max(0, maxRequests - entry.count);
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((entry.firstRequest + windowMs) / 1000)));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.firstRequest + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      console.warn(`[RATE LIMIT] Blocked: ${key} — ${entry.count}/${maxRequests}`);
      return res.status(429).json({ error: message, retryAfter });
    }

    next();
  };
}
