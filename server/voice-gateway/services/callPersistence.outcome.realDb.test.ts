// @vitest-environment node
//
// VA-15: the call-outcome UPDATE against a real Postgres, on a session-local
// TEMP table with the call_sessions columns it touches (no migration, no
// shared data). Skips cleanly when DATABASE_URL is unset or unreachable,
// like the other real-DB suites.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PERSIST_CALL_OUTCOME_SQL } from './callPersistence';

const URL_RAW = process.env.DATABASE_URL ?? '';

async function connectOrNull(): Promise<Client | null> {
  if (!URL_RAW) return null;
  const client = new Client({ connectionString: URL_RAW, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

const client = await connectOrNull();

describe.skipIf(!client)('persistCallOutcome SQL (real Postgres)', () => {
  beforeAll(async () => {
    await client!.query(`CREATE TEMP TABLE call_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      context JSONB DEFAULT '{}',
      updated_at TIMESTAMPTZ
    )`);
  });

  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  it('adds callOutcome, keeps other context keys, and the first outcome wins', async () => {
    await client!.query(
      `INSERT INTO call_sessions (id, tenant_id, context) VALUES ('cs-1', 't-1', $1), ('cs-2', 't-1', NULL), ('cs-3', 't-2', '{}')`,
      [JSON.stringify({ recordingPolicy: { policy: 'disabled' }, transcript: 'enc:abc' })],
    );

    const first = await client!.query(PERSIST_CALL_OUTCOME_SQL, ['t-1', 'cs-1', 'never_heard']);
    expect(first.rowCount).toBe(1);
    const second = await client!.query(PERSIST_CALL_OUTCOME_SQL, ['t-1', 'cs-1', 'caller_hangup']);
    expect(second.rowCount).toBe(0);

    const { rows } = await client!.query(`SELECT context FROM call_sessions WHERE id = 'cs-1'`);
    expect(rows[0].context).toEqual({
      recordingPolicy: { policy: 'disabled' },
      transcript: 'enc:abc',
      callOutcome: 'never_heard',
    });

    // NULL context is handled; another tenant's row is never touched.
    await client!.query(PERSIST_CALL_OUTCOME_SQL, ['t-1', 'cs-2', 'max_duration']);
    await client!.query(PERSIST_CALL_OUTCOME_SQL, ['t-1', 'cs-3', 'max_duration']);
    const rest = await client!.query(`SELECT id, context FROM call_sessions WHERE id IN ('cs-2', 'cs-3') ORDER BY id`);
    expect(rest.rows).toEqual([
      { id: 'cs-2', context: { callOutcome: 'max_duration' } },
      { id: 'cs-3', context: {} },
    ]);
  });
});
