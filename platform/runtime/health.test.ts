import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createProbeRouter,
  __resetReadinessForTests,
  markDraining,
  markEnvValidated,
  markRegistriesLoaded,
  isProcessDraining,
} from './health';

function app(dbPing: () => Promise<unknown>, isDraining?: () => boolean) {
  const a = express();
  a.use(createProbeRouter({ service: 'admin-api', role: () => 'api', dbPing, isDraining, dbTimeoutMs: 1_000 }));
  return a;
}

beforeEach(() => {
  __resetReadinessForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createProbeRouter', () => {
  it('/healthz never pings the DB', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('down'));
    const res = await request(app(ping)).get('/healthz');
    expect(res.status).toBe(200);
    expect(ping).not.toHaveBeenCalled();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('/readyz is 200 only when everything is ready', async () => {
    markEnvValidated(true);
    markRegistriesLoaded();
    const res = await request(app(async () => ({}))).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', service: 'admin-api', role: 'api', reasons: [] });
  });

  it('/readyz lists every reason code', async () => {
    const res = await request(app(async () => { throw new Error('x'); })).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reasons).toEqual(['env_not_validated', 'registries_not_loaded', 'db_unreachable']);
  });

  it('/readyz reports env_invalid and draining', async () => {
    markEnvValidated(false);
    markRegistriesLoaded();
    markDraining();
    expect(isProcessDraining()).toBe(true);
    const res = await request(app(async () => ({}))).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reasons).toEqual(['env_invalid', 'draining']);
  });

  it('/readyz reports db_timeout when SELECT 1 takes longer than 1 s', async () => {
    markEnvValidated(true);
    markRegistriesLoaded();
    const slow = () => new Promise((resolve) => setTimeout(resolve, 1_500));
    const started = Date.now();
    const res = await request(app(slow)).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reasons).toEqual(['db_timeout']);
    expect(Date.now() - started).toBeLessThan(1_450);
  });

  it('/readyz honors the external draining signal', async () => {
    markEnvValidated(true);
    markRegistriesLoaded();
    const res = await request(app(async () => ({}), () => true)).get('/readyz');
    expect(res.body.reasons).toEqual(['draining']);
  });
});
