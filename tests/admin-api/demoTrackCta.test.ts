/**
 * Coverage for the `POST /demo/track-cta` endpoint that records lead-intent
 * clicks from the public Demo page (TR-433).
 *
 * The Demo page tests confirm the frontend POSTs to `/api/demo/track-cta` with
 * `{ ctaType, agentType }` when prospects click "Start Free Trial" or
 * "Book a Demo" after completing a demo call. Those frontend tests do not
 * exercise the server route, so a silent 404, a 500, or a refactor that
 * dropped the persistence step would lose conversions from the highest-intent
 * traffic without anyone noticing.
 *
 * These tests mount the demo router with a mocked platform pool so we can
 * pin down four important behaviours:
 *
 *   1. POST with a valid `start_free_trial` payload returns 2xx and writes
 *      a `cta_clicked` row into `demo_analytics` with the ctaType and
 *      agentType preserved.
 *   2. POST with a valid `book_demo` payload also persists.
 *   3. POST with a missing/blank ctaType returns 400 without touching the DB.
 *   4. POST with an unknown ctaType returns 400 without touching the DB.
 *   5. A malformed JSON body returns a sensible 4xx without crashing the
 *      process.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import demoRouter from '../../server/admin-api/routes/demo';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(demoRouter);
  // Express 4 treats unhandled JSON parse errors as 400 by default, but the
  // default handler also leaks an HTML response. Wire a small JSON error
  // handler so the malformed-body assertion is meaningful.
  app.use((err: Error & { status?: number; statusCode?: number }, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: err.message });
  });
  return app;
}

describe('POST /demo/track-cta', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('persists a cta_clicked row when the Start Free Trial CTA is clicked', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await request(buildApp())
      .post('/demo/track-cta')
      .send({ ctaType: 'start_free_trial', agentType: 'medical-after-hours' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Exactly one INSERT into demo_analytics should be issued. We assert on
    // the SQL shape and the bound parameters so a future refactor that drops
    // the write (or stops capturing ctaType / agentType) fails loudly here.
    const insertCalls = queryMock.mock.calls.filter((call) =>
      /INSERT INTO demo_analytics/i.test(String(call[0])),
    );
    expect(insertCalls).toHaveLength(1);

    const [, params] = insertCalls[0] as [string, unknown[]];
    expect(params[0]).toBe('cta_clicked'); // event_type
    expect(params[1]).toBe('medical-after-hours'); // agent_type
    expect(typeof params[2]).toBe('string'); // ip_hash
    expect((params[2] as string).length).toBeGreaterThan(0);
    expect(params[3]).toBeNull(); // duration_seconds
    expect(params[4]).toBe('start_free_trial'); // cta_type
  });

  it('persists a cta_clicked row when the Book a Demo CTA is clicked', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await request(buildApp())
      .post('/demo/track-cta')
      .send({ ctaType: 'book_demo', agentType: 'dental' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const insertCalls = queryMock.mock.calls.filter((call) =>
      /INSERT INTO demo_analytics/i.test(String(call[0])),
    );
    expect(insertCalls).toHaveLength(1);
    const [, params] = insertCalls[0] as [string, unknown[]];
    expect(params[0]).toBe('cta_clicked');
    expect(params[1]).toBe('dental');
    expect(params[4]).toBe('book_demo');
  });

  it('still records the click when no agentType is provided', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await request(buildApp())
      .post('/demo/track-cta')
      .send({ ctaType: 'start_free_trial' });

    expect(res.status).toBe(200);
    const insertCalls = queryMock.mock.calls.filter((call) =>
      /INSERT INTO demo_analytics/i.test(String(call[0])),
    );
    expect(insertCalls).toHaveLength(1);
    const [, params] = insertCalls[0] as [string, unknown[]];
    expect(params[1]).toBeNull();
    expect(params[4]).toBe('start_free_trial');
  });

  it('returns 400 and skips the DB write when ctaType is missing', async () => {
    const res = await request(buildApp())
      .post('/demo/track-cta')
      .send({ agentType: 'dental' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ctaType/i);
    // No INSERT may be issued for invalid payloads — otherwise we'd be
    // polluting the analytics table with junk leads.
    const insertCalls = queryMock.mock.calls.filter((call) =>
      /INSERT INTO demo_analytics/i.test(String(call[0])),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('returns 400 when ctaType is not a recognised value', async () => {
    const res = await request(buildApp())
      .post('/demo/track-cta')
      .send({ ctaType: 'subscribe_newsletter', agentType: 'dental' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    const insertCalls = queryMock.mock.calls.filter((call) =>
      /INSERT INTO demo_analytics/i.test(String(call[0])),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('returns 400 when ctaType is not a string', async () => {
    const res = await request(buildApp())
      .post('/demo/track-cta')
      .send({ ctaType: 42 });

    expect(res.status).toBe(400);
    const insertCalls = queryMock.mock.calls.filter((call) =>
      /INSERT INTO demo_analytics/i.test(String(call[0])),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('returns 4xx without crashing when the body is malformed JSON', async () => {
    const res = await request(buildApp())
      .post('/demo/track-cta')
      .set('Content-Type', 'application/json')
      .send('{ this is not valid json');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const insertCalls = queryMock.mock.calls.filter((call) =>
      /INSERT INTO demo_analytics/i.test(String(call[0])),
    );
    expect(insertCalls).toHaveLength(0);
  });
});
