import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Express, RequestHandler } from 'express';

const a = vi.hoisted(() => ({ existsSyncMock: vi.fn(), isMarketingPathnameMock: vi.fn() }));

vi.mock('fs', () => ({ default: { existsSync: a.existsSyncMock }, existsSync: a.existsSyncMock }));
vi.mock('../../shared/spa/marketingRoutes', () => ({ isMarketingPathname: a.isMarketingPathnameMock }));

import { isProductionBoot, attachSpaFallback } from './spaFallback';

function fakeApp() {
  const handlers: Record<string, RequestHandler> = {};
  const uses: string[] = [];
  const app = {
    use: (...args: unknown[]) => { uses.push(typeof args[0] === 'string' ? (args[0] as string) : '<mw>'); },
    get: (route: string, handler: RequestHandler) => { handlers[route] = handler; },
  } as unknown as Express;
  return { app, handlers, uses };
}

beforeEach(() => {
  a.existsSyncMock.mockReset();
  a.isMarketingPathnameMock.mockReset().mockReturnValue(false);
});

describe('isProductionBoot', () => {
  it('is true when NODE_ENV or APP_ENV is production', () => {
    expect(isProductionBoot({ NODE_ENV: 'production' } as never)).toBe(true);
    expect(isProductionBoot({ APP_ENV: 'production' } as never)).toBe(true);
  });
  it('is false otherwise', () => {
    expect(isProductionBoot({ NODE_ENV: 'development' } as never)).toBe(false);
    expect(isProductionBoot({} as never)).toBe(false);
  });
});

describe('attachSpaFallback', () => {
  it('returns false when the client dist path does not exist', () => {
    a.existsSyncMock.mockReturnValue(false);
    const { app } = fakeApp();
    expect(attachSpaFallback(app, '/no/such/dir')).toBe(false);
  });

  it('mounts handlers and serves the in-app bundle for non-marketing paths', () => {
    // dist exists, but the marketing html does not.
    a.existsSyncMock.mockImplementation((p: string) => p === '/dist');
    const { app, handlers } = fakeApp();
    expect(attachSpaFallback(app, '/dist')).toBe(true);
    expect(handlers).toHaveProperty('/');
    expect(handlers).toHaveProperty('/*splat');

    const sent: string[] = [];
    const res = { sendFile: (f: string) => sent.push(f) } as never;
    handlers['/*splat']({ accepts: () => 'html', path: '/app/dashboard' } as never, res, vi.fn());
    expect(sent[0]).toContain('index.html');
    expect(sent[0]).not.toContain('index.public.html');
  });

  it('serves the marketing bundle for a marketing path when the marketing html exists', () => {
    a.existsSyncMock.mockReturnValue(true); // both dist and marketing html exist
    a.isMarketingPathnameMock.mockReturnValue(true);
    const { app, handlers } = fakeApp();
    attachSpaFallback(app, '/dist');

    const sent: string[] = [];
    const res = { sendFile: (f: string) => sent.push(f) } as never;
    handlers['/']({ accepts: () => 'html', path: '/pricing' } as never, res, vi.fn());
    expect(sent[0]).toContain('index.public.html');
  });
});
