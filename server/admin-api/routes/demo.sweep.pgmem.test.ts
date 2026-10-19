// Runs the demo cleanup SQL (periodic sweep + per-call cleanup) on pg-mem:
// only website-demo calls (marked via demo_analytics) lose their history;
// ordinary calls on the `demo` tenant (Sharp Line test calls) keep it.
import { DataType, newDb } from 'pg-mem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ pool: null as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> } }));

vi.mock('../../../platform/db', () => ({ getPlatformPool: () => h.pool }));
vi.mock('../../../platform/analytics/demoAnalyticsAlert', () => ({ raiseDemoAnalyticsWriteFailureAlert: vi.fn() }));
vi.mock('../../../platform/demo/healthcareDemoScenario', () => ({ executeHealthcareDemoScenario: vi.fn() }));

import { isWebsiteDemoNumber, scheduleDemoDataCleanup, sweepStaleDemoData, WEBSITE_DEMO_CALL_SID_KEY } from './demo';

// end_time is TIMESTAMP in migration 005; TIMESTAMPTZ here so pg-mem can compare it with NOW().
const SCHEMA = `
  CREATE TABLE phone_numbers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, is_demo BOOLEAN DEFAULT false);
  CREATE TABLE demo_agents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_template TEXT NOT NULL, is_active BOOLEAN DEFAULT true);
  CREATE TABLE call_sessions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, call_sid TEXT,
    lifecycle_state TEXT NOT NULL, context JSONB DEFAULT '{}', end_time TIMESTAMPTZ
  );
  CREATE TABLE call_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, call_session_id TEXT NOT NULL, event_type TEXT NOT NULL);
  CREATE TABLE demo_analytics (
    id SERIAL PRIMARY KEY, event_type TEXT NOT NULL, agent_type TEXT, ip_hash TEXT NOT NULL,
    duration_seconds INTEGER, cta_type TEXT, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return ((await h.pool.query(sql, params)) as { rows: T[] }).rows;
}

async function addCall(id: string, callSid: string, opts: { endedMinutesAgo: number; websiteDemo: boolean }) {
  await q(
    `INSERT INTO call_sessions (id, tenant_id, call_sid, lifecycle_state, context, end_time)
     VALUES ($1, 'demo', $2, 'CALL_COMPLETED', $3, $4)`,
    [id, callSid, JSON.stringify({ transcript: 'hi' }), new Date(Date.now() - opts.endedMinutesAgo * 60_000)],
  );
  await q(
    `INSERT INTO call_events (id, tenant_id, call_session_id, event_type)
     VALUES ($1, 'demo', $2, 'CALL_RECEIVED'), ($3, 'demo', $2, 'CALL_COMPLETED')`,
    [`${id}-e1`, id, `${id}-e2`],
  );
  // Every demo-tenant call records call_started; only website-demo calls carry the marker.
  await q(`INSERT INTO demo_analytics (event_type, ip_hash, metadata) VALUES ('call_started', 'h', $1)`, [
    JSON.stringify(opts.websiteDemo ? { [WEBSITE_DEMO_CALL_SID_KEY]: callSid } : {}),
  ]);
}

async function state(id: string) {
  const events = await q(`SELECT id FROM call_events WHERE call_session_id = $1`, [id]);
  const [session] = await q<{ context: Record<string, unknown> }>(`SELECT context FROM call_sessions WHERE id = $1`, [id]);
  return { events: events.length, context: session.context };
}

const KEPT = { events: 2, context: { transcript: 'hi' } };
const CLEANED = { events: 0, context: {} };

beforeEach(() => {
  const db = newDb();
  // pg-mem lacks `interval * number` (the sweep's `INTERVAL '1 minute' * $2`; params arrive as text).
  for (const right of [DataType.text, DataType.integer]) {
    db.public.registerOperator({
      operator: '*',
      left: DataType.interval,
      right,
      returns: DataType.interval,
      implementation: (iv: Record<string, number>, n: string | number) =>
        Object.fromEntries(Object.entries(iv).map(([k, v]) => [k, v * Number(n)])),
    });
  }
  db.public.none(SCHEMA);
  const { Pool } = db.adapters.createPg();
  h.pool = new Pool();
});

describe('sweepStaleDemoData', () => {
  it('keeps call_events and context for an ordinary finished call on tenant demo (not a website demo)', async () => {
    await addCall('sharp-line', 'CA-sharp', { endedMinutesAgo: 120, websiteDemo: false });
    // Control: proves the sweep actually ran in this test.
    await addCall('web-old', 'CA-web-old', { endedMinutesAgo: 120, websiteDemo: true });
    await sweepStaleDemoData();
    expect(await state('sharp-line')).toEqual(KEPT);
    expect(await state('web-old')).toEqual(CLEANED);
  });

  it('cleans a finished website-demo call older than the retention window', async () => {
    await addCall('web-old', 'CA-web-old', { endedMinutesAgo: 30, websiteDemo: true });
    await sweepStaleDemoData();
    expect(await state('web-old')).toEqual(CLEANED);
  });

  it('leaves a website-demo call inside the retention window alone', async () => {
    await addCall('web-new', 'CA-web-new', { endedMinutesAgo: 5, websiteDemo: true });
    await addCall('web-old', 'CA-web-old', { endedMinutesAgo: 30, websiteDemo: true });
    await sweepStaleDemoData();
    expect(await state('web-new')).toEqual(KEPT);
    expect(await state('web-old')).toEqual(CLEANED);
  });
});

describe('scheduleDemoDataCleanup', () => {
  it('cleans a marked website-demo session and never an unmarked one', async () => {
    await addCall('web', 'CA-web', { endedMinutesAgo: 0, websiteDemo: true });
    await addCall('sharp-line', 'CA-sharp', { endedMinutesAgo: 0, websiteDemo: false });
    scheduleDemoDataCleanup('sharp-line', 0);
    scheduleDemoDataCleanup('web', 0);
    // Timers fire in order, so once 'web' is clean the 'sharp-line' run is done too.
    await vi.waitFor(async () => expect(await state('web')).toEqual(CLEANED));
    expect(await state('sharp-line')).toEqual(KEPT);
  });
});

describe('isWebsiteDemoNumber', () => {
  it('is true only for a published demo number routed to a website-demo agent template', async () => {
    await q(`INSERT INTO phone_numbers (id, tenant_id, is_demo) VALUES ('pn-web', 'demo', true), ('pn-test', 'demo', false)`);
    await q(`INSERT INTO demo_agents (id, tenant_id, agent_template) VALUES ('da-1', 'demo', 'dental')`);
    expect(await isWebsiteDemoNumber('pn-web', 'dental')).toBe(true);
    // Sharp Line's composer barbershop agent has no demo_agents template.
    expect(await isWebsiteDemoNumber('pn-web', 'barbershop')).toBe(false);
    expect(await isWebsiteDemoNumber('pn-test', 'dental')).toBe(false);
    expect(await isWebsiteDemoNumber(undefined, 'dental')).toBe(false);
  });
});
