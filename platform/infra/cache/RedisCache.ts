/**
 * Lightweight JSON cache abstraction used in front of expensive read paths
 * (e.g. the public GIN benchmark snapshot).
 *
 * Two backends are supported:
 *
 *   1. Redis (preferred) — enabled when `REDIS_URL` is set in the environment
 *      AND the `ioredis` package is installed. We dynamic-import `ioredis` so
 *      the dependency is optional: deployments that don't run Redis don't
 *      need to install it.
 *
 *   2. In-process Map (fallback) — used when Redis is not configured or the
 *      Redis client fails to connect. This still gives us a meaningful win
 *      on a single instance under bursty traffic; multiple instances simply
 *      each maintain their own cache and the DB sees ~N hits per TTL window
 *      instead of one per request.
 *
 * The cache is intentionally lossy: on any error (Redis offline, timeout,
 * malformed payload) we behave as a cache miss and let the caller hit the
 * source of truth (Postgres). Callers must always be prepared to recompute.
 */

import { createLogger } from '../../core/logger';

const logger = createLogger('REDIS_CACHE');

export type CacheBackend = 'redis' | 'memory';

export interface CacheClient {
  /** Returns the parsed JSON value, or `null` on miss / error / expiry. */
  getJson<T>(key: string): Promise<T | null>;
  /** Stores the JSON-serialized value with a TTL (seconds). Best-effort. */
  setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /** Removes the key. Best-effort. */
  del(key: string): Promise<void>;
  /** Backend currently in use (for diagnostics). */
  backend(): CacheBackend;
}

interface MemoryEntry {
  value: string;
  expiresAtMs: number;
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  on(event: string, handler: (err: unknown) => void): void;
  quit(): Promise<unknown>;
}

class MemoryCache implements CacheClient {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 512) {
    this.maxEntries = maxEntries;
  }

  backend(): CacheBackend {
    return 'memory';
  }

  async getJson<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      this.store.delete(key);
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (this.store.size >= this.maxEntries) {
      // Cheap eviction: drop the oldest insertion to keep memory bounded.
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return;
    }
    this.store.set(key, {
      value: serialized,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Test-only — wipe the cache between tests. */
  clear(): void {
    this.store.clear();
  }
}

class RedisCacheClient implements CacheClient {
  constructor(private readonly client: RedisLike) {}

  backend(): CacheBackend {
    return 'redis';
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw == null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn('Redis getJson failed, treating as miss', { key, error: String(err) });
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await this.client.set(key, serialized, 'EX', Math.max(1, Math.floor(ttlSeconds)));
    } catch (err) {
      logger.warn('Redis setJson failed', { key, error: String(err) });
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.warn('Redis del failed', { key, error: String(err) });
    }
  }
}

let sharedClient: CacheClient | null = null;
let initPromise: Promise<CacheClient> | null = null;

async function tryBuildRedisClient(redisUrl: string): Promise<CacheClient | null> {
  try {
    // Dynamic import keeps `ioredis` optional — deployments without Redis
    // don't have to install it. The `Function('return import(...))()` form
    // hides the module specifier from TypeScript / bundlers so a missing
    // package is purely a runtime miss instead of a compile-time error.
    const dynamicImport = new Function('id', 'return import(id);') as (
      id: string,
    ) => Promise<unknown>;

    type IORedisModule = { default?: new (url: string, opts?: unknown) => RedisLike };
    let mod: IORedisModule | null = null;
    try {
      mod = (await dynamicImport('ioredis')) as IORedisModule;
    } catch {
      mod = null;
    }

    const Ctor = mod?.default;
    if (!Ctor) {
      logger.info('REDIS_URL set but ioredis is not installed; using in-memory cache fallback');
      return null;
    }

    const client = new Ctor(redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

    client.on('error', (err: unknown) => {
      logger.warn('Redis client error', { error: String(err) });
    });

    return new RedisCacheClient(client);
  } catch (err) {
    logger.warn('Failed to initialise Redis client; using in-memory cache fallback', {
      error: String(err),
    });
    return null;
  }
}

/**
 * Get the process-wide cache client. Initialised lazily on first call.
 * Always resolves — never throws — and always returns a usable client
 * (Redis or in-memory).
 */
export async function getCacheClient(): Promise<CacheClient> {
  if (sharedClient) return sharedClient;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const url = process.env.REDIS_URL?.trim();
    if (url) {
      const redis = await tryBuildRedisClient(url);
      if (redis) {
        logger.info('Cache backend: Redis');
        sharedClient = redis;
        return redis;
      }
    }
    const memory = new MemoryCache();
    logger.info('Cache backend: in-memory');
    sharedClient = memory;
    return memory;
  })();

  return initPromise;
}

/**
 * Test-only helpers — let unit tests inject a deterministic backend and
 * reset the singleton between cases.
 */
export function __setCacheClientForTests(client: CacheClient | null): void {
  sharedClient = client;
  initPromise = client ? Promise.resolve(client) : null;
}

export function __createMemoryCacheForTests(maxEntries?: number): CacheClient & { clear: () => void } {
  return new MemoryCache(maxEntries);
}
