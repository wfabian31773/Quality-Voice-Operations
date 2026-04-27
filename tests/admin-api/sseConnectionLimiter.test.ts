import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createRateLimiter } from '../../platform/infra/rate-limit/createRateLimiter';
import {
  createSseConnectionLimiter,
  attachSseHeartbeat,
  resolveLiveStreamCap,
  registerSseConnection,
  ackSseConnection,
  clearSseRegistry,
  getTenantSseConnectionLimiter,
  __resetTenantSseConnectionLimiterForTesting,
} from '../../platform/infra/rate-limit/sseConnectionLimiter';

function makeReq(tenantId = 'tenant-a'): Request & EventEmitter {
  const req = new EventEmitter() as Request & EventEmitter;
  (req as Request & { user?: { tenantId: string } }).user = { tenantId };
  const socket = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number) => void;
    destroy: () => void;
  };
  socket.setTimeout = vi.fn();
  socket.destroy = vi.fn();
  (req as Request & { socket: typeof socket }).socket = socket;
  return req;
}

function makeRes(): Response & {
  __statusCode: number;
  __headers: Record<string, string>;
  __body: unknown;
  __writes: string[];
  __ended: boolean;
} {
  const res = new EventEmitter() as Response &
    EventEmitter & {
      __statusCode: number;
      __headers: Record<string, string>;
      __body: unknown;
      __writes: string[];
      __ended: boolean;
    };
  res.__statusCode = 200;
  res.__headers = {};
  res.__body = undefined;
  res.__writes = [];
  res.__ended = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.status = vi.fn((code: number) => {
    res.__statusCode = code;
    return res;
  }) as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.__body = body;
    return res;
  }) as Response['json'];
  res.setHeader = vi.fn((name: string, value: string | number | readonly string[]) => {
    res.__headers[name] = String(value);
    return res;
  }) as Response['setHeader'];
  res.write = vi.fn((chunk: string) => {
    res.__writes.push(chunk);
    return true;
  }) as unknown as Response['write'];
  res.end = vi.fn(() => {
    res.__ended = true;
    res.writableEnded = true;
    return res;
  }) as Response['end'];
  return res;
}

describe('createSseConnectionLimiter', () => {
  it('admits up to maxConcurrent connections per tenant and rejects the next', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 3 });
    const accepted: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const req = makeReq('tenant-a');
      const res = makeRes();
      accepted.push(limiter.acquire(req, res));
      if (i === 3) {
        expect(res.__statusCode).toBe(429);
        expect((res.__body as { error: string }).error).toMatch(/concurrent live-stream/i);
        expect((res.__body as { maxConcurrent: number }).maxConcurrent).toBe(3);
        expect(res.__headers['Retry-After']).toBe('5');
      }
    }
    expect(accepted).toEqual([true, true, true, false]);
    expect(limiter.count('tenant-a')).toBe(3);
  });

  it('isolates counts per tenant', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 2 });
    const a1 = limiter.acquire(makeReq('tenant-a'), makeRes());
    const a2 = limiter.acquire(makeReq('tenant-a'), makeRes());
    const a3 = limiter.acquire(makeReq('tenant-a'), makeRes());
    const b1 = limiter.acquire(makeReq('tenant-b'), makeRes());
    const b2 = limiter.acquire(makeReq('tenant-b'), makeRes());
    expect(a1).toBe(true);
    expect(a2).toBe(true);
    expect(a3).toBe(false);
    expect(b1).toBe(true);
    expect(b2).toBe(true);
    expect(limiter.count('tenant-a')).toBe(2);
    expect(limiter.count('tenant-b')).toBe(2);
    expect(limiter.total()).toBe(4);
  });

  it('releases the slot when req emits close', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 1 });
    const req1 = makeReq('tenant-a');
    expect(limiter.acquire(req1, makeRes())).toBe(true);
    expect(limiter.acquire(makeReq('tenant-a'), makeRes())).toBe(false);
    req1.emit('close');
    expect(limiter.count('tenant-a')).toBe(0);
    expect(limiter.acquire(makeReq('tenant-a'), makeRes())).toBe(true);
  });

  it('release is idempotent (close on both req and res)', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 5 });
    const req = makeReq('tenant-a');
    const res = makeRes();
    limiter.acquire(req, res);
    expect(limiter.count('tenant-a')).toBe(1);
    req.emit('close');
    res.emit('close');
    expect(limiter.count('tenant-a')).toBe(0);
  });

  it('falls back to "platform" when no tenantId is present', () => {
    const limiter = createSseConnectionLimiter({ maxConcurrent: 2 });
    const req = new EventEmitter() as Request & EventEmitter;
    const res = makeRes();
    expect(limiter.acquire(req, res)).toBe(true);
    expect(limiter.count('platform')).toBe(1);
  });

  it('uses a custom message when provided', () => {
    const limiter = createSseConnectionLimiter({
      maxConcurrent: 1,
      message: 'custom-msg',
    });
    limiter.acquire(makeReq('tenant-a'), makeRes());
    const res = makeRes();
    limiter.acquire(makeReq('tenant-a'), res);
    expect((res.__body as { error: string }).error).toBe('custom-msg');
  });
});

describe('attachSseHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes ": heartbeat\\n\\n" every intervalMs', () => {
    const req = makeReq();
    const res = makeRes();
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 0 });
    vi.advanceTimersByTime(3500);
    const heartbeats = res.__writes.filter((w) => w === ': heartbeat\n\n');
    expect(heartbeats.length).toBe(3);
  });

  it('stops writing heartbeats after req close', () => {
    const req = makeReq();
    const res = makeRes();
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 0 });
    vi.advanceTimersByTime(2500);
    req.emit('close');
    const beforeClose = res.__writes.length;
    vi.advanceTimersByTime(5000);
    expect(res.__writes.length).toBe(beforeClose);
  });

  it('deterministically force-closes after idleTimeoutMs with NO liveness signals (writes succeeding)', () => {
    // The reviewer specifically called this out: even when res.write() keeps
    // returning true (no backpressure), the connection must auto-disconnect
    // at ~idleTimeoutMs because the server has no proof the client is alive.
    const req = makeReq();
    const res = makeRes();
    // res.write returns true throughout — no backpressure, no drain events.
    res.write = vi.fn((chunk: string) => {
      res.__writes.push(chunk);
      return true;
    }) as unknown as Response['write'];
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 60_000 });

    // At t=59s, no liveness signals yet → not closed.
    vi.advanceTimersByTime(59_000);
    expect(res.end).not.toHaveBeenCalled();
    // Past 60s, the deterministic checker fires force-close.
    vi.advanceTimersByTime(2_000);
    expect(res.end).toHaveBeenCalled();
    expect(req.socket.destroy).toHaveBeenCalled();
  });

  it('drain event resets the liveness deadline (treated as client-side ack)', () => {
    const req = makeReq();
    const res = makeRes();
    res.write = vi.fn(() => true) as unknown as Response['write'];
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 60_000 });

    // Just before the 60s deadline, simulate a drain → liveness reset.
    vi.advanceTimersByTime(50_000);
    res.emit('drain');
    // Another 50s passes; idle = 50s < 60s → still alive.
    vi.advanceTimersByTime(50_000);
    expect(res.end).not.toHaveBeenCalled();
    // Without further liveness, the deadline expires ~60s after last drain.
    vi.advanceTimersByTime(11_000);
    expect(res.end).toHaveBeenCalled();
  });

  it('explicit ack() resets the liveness deadline (companion ack endpoint hook)', () => {
    const req = makeReq();
    const res = makeRes();
    res.write = vi.fn(() => true) as unknown as Response['write'];
    const handle = attachSseHeartbeat(req, res, {
      intervalMs: 1000,
      idleTimeoutMs: 60_000,
    });

    // Tick across multiple deadlines while ack()ing each cycle.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(50_000);
      handle.ack();
    }
    expect(res.end).not.toHaveBeenCalled();

    // Stop ack-ing; the connection must close after one more 60s window.
    vi.advanceTimersByTime(61_000);
    expect(res.end).toHaveBeenCalled();
  });

  it('does not write after writableEnded becomes true', () => {
    const req = makeReq();
    const res = makeRes();
    attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 0 });
    res.writableEnded = true;
    vi.advanceTimersByTime(2500);
    expect(res.__writes.filter((w) => w === ': heartbeat\n\n').length).toBe(0);
  });

  it('returned cleanup function clears the heartbeat timer', () => {
    const req = makeReq();
    const res = makeRes();
    const cleanup = attachSseHeartbeat(req, res, { intervalMs: 1000, idleTimeoutMs: 0 });
    vi.advanceTimersByTime(1500);
    cleanup();
    const before = res.__writes.length;
    vi.advanceTimersByTime(5000);
    expect(res.__writes.length).toBe(before);
  });
});

describe('source contract — SSE endpoints use the shared limiter and heartbeat helper', () => {
  it('callsLive route uses the shared tenant SSE limiter and createRateLimiter', () => {
    const src = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/callsLive.ts'),
      'utf-8',
    );
    expect(src).toMatch(/import\s*\{\s*createRateLimiter\s*\}\s*from\s*['"][^'"]*createRateLimiter['"]/);
    expect(src).toMatch(/createRateLimiter\(\s*\{[\s\S]*?keyGenerator[\s\S]*?\.user\?\.tenantId/);
    expect(src).toMatch(/getTenantSseConnectionLimiter/);
    expect(src).toMatch(/attachSseHeartbeat/);
    expect(src).toMatch(/getTenantSseConnectionLimiter\(\)\.acquire\(req,\s*res\)/);
    expect(src).toMatch(/router\.get\(\s*['"]\/calls\/live['"][\s\S]*?callsLiveRateLimiter/);
    // Must NOT create its own per-route concurrency limiter — that would
    // allow a tenant to exceed the cap by opening connections on each
    // route independently.
    expect(src).not.toMatch(/createSseConnectionLimiter\(/);
    const acquireIdx = src.indexOf('getTenantSseConnectionLimiter().acquire');
    const writeHeadIdx = src.indexOf('res.writeHead(200');
    expect(acquireIdx).toBeGreaterThan(0);
    expect(writeHeadIdx).toBeGreaterThan(acquireIdx);
  });

  it('operations route uses the shared tenant SSE limiter and createRateLimiter', () => {
    const src = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/operations.ts'),
      'utf-8',
    );
    expect(src).toMatch(/import\s*\{\s*createRateLimiter\s*\}\s*from\s*['"][^'"]*createRateLimiter['"]/);
    expect(src).toMatch(/createRateLimiter\(\s*\{[\s\S]*?keyGenerator[\s\S]*?\.user\?\.tenantId/);
    expect(src).toMatch(/getTenantSseConnectionLimiter/);
    expect(src).toMatch(/attachSseHeartbeat/);
    expect(src).toMatch(/getTenantSseConnectionLimiter\(\)\.acquire\(req,\s*res\)/);
    expect(src).toMatch(/router\.get\(\s*['"]\/operations\/calls\/:callId\/live['"][\s\S]*?operationsCallLiveRateLimiter/);
    expect(src).not.toMatch(/createSseConnectionLimiter\(/);
    const acquireIdx = src.indexOf('getTenantSseConnectionLimiter().acquire');
    const writeHeadIdx = src.indexOf('res.writeHead(200', acquireIdx);
    expect(acquireIdx).toBeGreaterThan(0);
    expect(writeHeadIdx).toBeGreaterThan(acquireIdx);
  });

  it('both SSE routes import the shared limiter from the same module', () => {
    const callsLive = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/callsLive.ts'),
      'utf-8',
    );
    const ops = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/operations.ts'),
      'utf-8',
    );
    const importPattern =
      /from\s*['"][^'"]*platform\/infra\/rate-limit\/sseConnectionLimiter['"]/;
    expect(callsLive).toMatch(importPattern);
    expect(ops).toMatch(importPattern);
    expect(callsLive).toMatch(/getTenantSseConnectionLimiter/);
    expect(ops).toMatch(/getTenantSseConnectionLimiter/);
  });

  it('resolveLiveStreamCap sanitizes env values', () => {
    expect(resolveLiveStreamCap(undefined)).toBe(20);
    expect(resolveLiveStreamCap('')).toBe(20);
    expect(resolveLiveStreamCap('not-a-number')).toBe(20);
    expect(resolveLiveStreamCap('-5')).toBe(20);
    expect(resolveLiveStreamCap('0')).toBe(20);
    expect(resolveLiveStreamCap('Infinity')).toBe(20);
    expect(resolveLiveStreamCap('50')).toBe(50);
    expect(resolveLiveStreamCap('25.7')).toBe(25);
  });

  it('getTenantSseConnectionLimiter returns the same singleton across calls', () => {
    __resetTenantSseConnectionLimiterForTesting();
    const a = getTenantSseConnectionLimiter();
    const b = getTenantSseConnectionLimiter();
    expect(a).toBe(b);
  });
});

describe('shared tenant SSE limiter — cross-route aggregate cap', () => {
  afterEach(() => {
    __resetTenantSseConnectionLimiterForTesting();
  });

  it('a single tenant cannot exceed the cap by spreading connections across routes', () => {
    // Simulate the cap = 3.
    __resetTenantSseConnectionLimiterForTesting(
      createSseConnectionLimiter({ maxConcurrent: 3 }),
    );

    // Route A (mimics /calls/live): 2 connections.
    const a1 = getTenantSseConnectionLimiter().acquire(makeReq('tenant-x'), makeRes());
    const a2 = getTenantSseConnectionLimiter().acquire(makeReq('tenant-x'), makeRes());
    // Route B (mimics /operations/calls/:callId/live): 1 connection.
    const b1 = getTenantSseConnectionLimiter().acquire(makeReq('tenant-x'), makeRes());
    expect([a1, a2, b1]).toEqual([true, true, true]);

    // Tenant has now filled the cap across both routes. The 4th — on
    // either route — must be rejected.
    const res4a = makeRes();
    const denied4a = getTenantSseConnectionLimiter().acquire(makeReq('tenant-x'), res4a);
    expect(denied4a).toBe(false);
    expect(res4a.__statusCode).toBe(429);

    const res4b = makeRes();
    const denied4b = getTenantSseConnectionLimiter().acquire(makeReq('tenant-x'), res4b);
    expect(denied4b).toBe(false);
    expect(res4b.__statusCode).toBe(429);

    // A different tenant is unaffected.
    const other = getTenantSseConnectionLimiter().acquire(makeReq('tenant-y'), makeRes());
    expect(other).toBe(true);
  });

  it('route-level integration: shared limiter caps a tenant across two SSE routes', async () => {
    __resetTenantSseConnectionLimiterForTesting(
      createSseConnectionLimiter({ maxConcurrent: 2 }),
    );

    const app = express();
    const stubAuth = (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: { tenantId: string } }).user = {
        tenantId: 'tenant-int',
      };
      next();
    };

    // Two distinct SSE-style routes that share the singleton limiter. We
    // hold each accepted connection open via the response so the slot
    // stays reserved until the test releases it.
    const heldResponses: Response[] = [];
    const stubSseHandler = (_req: Request, res: Response) => {
      if (
        !getTenantSseConnectionLimiter().acquire(_req as unknown as Request, res)
      ) {
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: ok\ndata: {}\n\n');
      heldResponses.push(res);
    };

    app.get('/route-a/live', stubAuth, stubSseHandler);
    app.get('/route-b/live', stubAuth, stubSseHandler);

    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    const openSse = (path: string) =>
      new Promise<{ status: number; req: http.ClientRequest }>((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream' } },
          (res) => {
            res.on('data', () => {
              if (!resolved) {
                resolved = true;
                resolve({ status: res.statusCode ?? 0, req });
              }
            });
            res.on('end', () => {
              if (!resolved) {
                resolved = true;
                resolve({ status: res.statusCode ?? 0, req });
              }
            });
          },
        );
        let resolved = false;
        req.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      });

    const a = await openSse('/route-a/live');
    const b = await openSse('/route-b/live');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Cap is 2; the next request — on either route — must be 429.
    const denied = await new Promise<number>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port, path: '/route-a/live' },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        )
        .on('error', reject);
    });
    expect(denied).toBe(429);

    a.req.destroy();
    b.req.destroy();
    for (const r of heldResponses) {
      try { r.end(); } catch { /* already ended */ }
    }
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('neither SSE route uses the old inline 15-second heartbeat setInterval pattern', () => {
    const callsLive = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/callsLive.ts'),
      'utf-8',
    );
    const ops = readFileSync(
      join(process.cwd(), 'server/admin-api/routes/operations.ts'),
      'utf-8',
    );
    const oldPattern = /setInterval\(\s*\(\)\s*=>\s*\{\s*if\s*\(\s*alive\s*\)\s*res\.write\(['"]:\\n\\n['"]\)/;
    expect(callsLive).not.toMatch(oldPattern);
    expect(ops).not.toMatch(oldPattern);
  });
});

/**
 * End-to-end integration: spin up a real Express app with the same middleware
 * stack the SSE routes use (auth stub → tenant rate limiter → concurrency
 * limiter) and verify a single tenant is capped past the configured limit.
 *
 * We use a tiny non-streaming handler (just res.end()) so supertest's request
 * lifecycle completes immediately; the limiter's release-on-close hook fires
 * on response 'close'. We cap concurrency to 3 and serialize requests so all
 * three slots are used and the 4th sees 429.
 */
describe('SSE rate-limit + concurrency cap (route-level integration)', () => {
  /**
   * End-to-end ack flow with real timers and a real HTTP server.
   * Asserts the deterministic ~60s force-close (scaled to 250ms here) works:
   *   - a non-acking client is disconnected within ~one idleTimeoutMs
   *   - an actively-acking client stays connected past several deadlines
   */
  describe('explicit ack lifecycle (real timers, real socket)', () => {
    function buildServer(idleTimeoutMs: number) {
      const app = express();
      app.use(express.json());

      app.get('/sse', (req: Request, res: Response) => {
        const tenantId = 'tenant-int';
        (req as Request & { user: { tenantId: string } }).user = { tenantId };
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const connectionId = `conn-${Math.random().toString(36).slice(2)}`;
        res.write(`event: connection\ndata: {"connectionId":"${connectionId}"}\n\n`);
        const handle = attachSseHeartbeat(req, res, {
          intervalMs: Math.max(50, Math.floor(idleTimeoutMs / 4)),
          idleTimeoutMs,
        });
        const unregister = registerSseConnection(tenantId, connectionId, handle.ack);
        req.on('close', () => {
          unregister();
          handle();
        });
      });

      app.post('/sse/ack', (req: Request, res: Response) => {
        const { connectionId } = (req.body ?? {}) as { connectionId?: string };
        if (!connectionId) return res.status(400).end();
        const ok = ackSseConnection('tenant-int', connectionId);
        return res.status(ok ? 204 : 404).end();
      });

      const server = http.createServer(app);
      return server;
    }

    afterEach(() => {
      clearSseRegistry();
    });

    it('non-acking client is force-closed within ~idleTimeoutMs', async () => {
      const idleTimeoutMs = 300;
      const server = buildServer(idleTimeoutMs);
      await new Promise<void>((r) => server.listen(0, r));
      const port = (server.address() as AddressInfo).port;

      const result = await new Promise<{ elapsedMs: number }>((resolve, reject) => {
        const startedAt = Date.now();
        const settled = (label: string) => () => {
          resolve({ elapsedMs: Date.now() - startedAt });
        };
        const req = http.get(`http://127.0.0.1:${port}/sse`, (res) => {
          res.on('data', () => {});
          res.on('close', settled('close'));
          res.on('end', settled('end'));
        });
        // 'aborted' fires when server destroys the socket — that is the
        // expected outcome.
        req.on('close', settled('req-close'));
        req.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ||
              err.message === 'aborted' ||
              err.message === 'socket hang up') {
            resolve({ elapsedMs: Date.now() - startedAt });
          } else {
            reject(err);
          }
        });
        setTimeout(() => reject(new Error('did not close in time')), 5_000);
      });

      expect(result.elapsedMs).toBeGreaterThanOrEqual(idleTimeoutMs - 100);
      expect(result.elapsedMs).toBeLessThan(idleTimeoutMs * 4);

      await new Promise<void>((r) => server.close(() => r()));
    });

    it('actively-acking client stays connected past multiple idleTimeoutMs windows', async () => {
      const idleTimeoutMs = 500;
      const server = buildServer(idleTimeoutMs);
      await new Promise<void>((r) => server.listen(0, r));
      const port = (server.address() as AddressInfo).port;

      let connectionId: string | null = null;
      let stillOpen = true;

      const req = http.get(`http://127.0.0.1:${port}/sse`, (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf-8');
          const m = buf.match(/"connectionId":"([^"]+)"/);
          if (m && !connectionId) connectionId = m[1];
        });
        res.on('close', () => {
          stillOpen = false;
        });
      });
      req.on('close', () => {
        stillOpen = false;
      });

      // Wait for the SSE handshake + connectionId.
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const t = setInterval(() => {
          if (connectionId) {
            clearInterval(t);
            resolve();
          } else if (Date.now() - start > 2_000) {
            clearInterval(t);
            reject(new Error('no connectionId'));
          }
        }, 10);
      });

      const sendAck = () =>
        new Promise<number>((resolve, reject) => {
          const post = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/sse/ack',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
            (r) => {
              r.resume();
              r.on('end', () => resolve(r.statusCode ?? 0));
            },
          );
          post.on('error', reject);
          post.end(JSON.stringify({ connectionId }));
        });

      // Ack every idleTimeoutMs/3 for ~3 idle windows. Connection must stay
      // open the whole time.
      const ackEveryMs = Math.floor(idleTimeoutMs / 3);
      const totalAcks = 6;
      for (let i = 0; i < totalAcks; i++) {
        const status = await sendAck();
        expect(status).toBe(204);
        await new Promise((r) => setTimeout(r, ackEveryMs));
      }

      expect(stillOpen).toBe(true);

      // Stop acking — within a few windows the deterministic checker closes it.
      const stoppedAt = Date.now();
      await new Promise<void>((resolve, reject) => {
        const t = setInterval(() => {
          if (!stillOpen) {
            clearInterval(t);
            resolve();
          } else if (Date.now() - stoppedAt > idleTimeoutMs * 5) {
            clearInterval(t);
            reject(new Error('did not close after acks stopped'));
          }
        }, 20);
      });

      req.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    });
  });

  it('per-tenant rate limiter trips after exceeding the request window cap', async () => {
    const app = express();
    const tenantLimiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 3,
      keyGenerator: (req) =>
        ((req as Request & { user?: { tenantId: string } }).user?.tenantId ??
          req.ip) as string,
    });
    app.get(
      '/calls/live',
      (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { user?: { tenantId: string } }).user = {
          tenantId: 'tenant-int',
        };
        next();
      },
      tenantLimiter,
      (_req: Request, res: Response) => res.status(200).end('ok'),
    );

    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(app).get('/calls/live');
      codes.push(r.status);
    }
    // First 3 succeed, remaining 2 are throttled.
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});
