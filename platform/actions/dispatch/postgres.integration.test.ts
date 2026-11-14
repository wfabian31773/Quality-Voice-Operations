// @vitest-environment node
// Dispatch actions through runAction against a throwaway local Postgres (all
// migrations), with the real postgres action store and every transaction
// running as the NOBYPASSRLS tester role bound to app.tenant_id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  postgresActionStore,
  runAction,
  type ActionContext,
  type ActionResult,
  type TenantTx,
} from '../core';
import {
  CREATE_JOB_COMMIT,
  CREATE_JOB_PREPARE,
  createDispatchActions,
  GET_JOB_STATUS,
  UPDATE_STATUS,
} from './actions';

const ADMIN_URL_RAW =
  process.env.DATABASE_URL ?? process.env.DATABASE_URL_PRIVILEGED ?? 'postgresql://ubuntu@127.0.0.1:5432/postgres';

function adminUrl(database?: string): string | null {
  try {
    const u = new URL(ADMIN_URL_RAW);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return null;
    if (database) u.pathname = `/${database}`;
    return u.toString();
  } catch {
    return null;
  }
}

async function probeReachable(): Promise<boolean> {
  const url = adminUrl();
  if (!url) return false;
  const probe = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const dbReachable = await probeReachable();

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

function allMigrations(): { name: string; sql: string }[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql')).sort();
  const iPins = files.indexOf('063_call_saved_view_pins.sql');
  const iPinOrder = files.indexOf('063_call_saved_views_pin_order.sql');
  if (iPins >= 0 && iPinOrder >= 0 && iPins < iPinOrder) {
    files.splice(iPinOrder, 1);
    files.splice(iPins, 0, '063_call_saved_views_pin_order.sql');
  }
  return files.map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl()! });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

async function applyMigration(pool: Pool, m: { name: string; sql: string }): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('COMMIT');
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const message = (err as Error).message;
      if (attempt >= 5 || !/tuple concurrently (updated|deleted)|deadlock detected/.test(message)) {
        throw new Error(`Migration ${m.name} failed: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    } finally {
      client.release();
    }
  }
}

const TZ = 'America/New_York';
const NOW = new Date('2026-10-19T12:00:00Z');
const PHONE = '+15555550142';
const ADDRESS = {
  line1: '123 Main St',
  unit: 'Apt 4B',
  city: 'Springfield',
  region: 'IL',
  postal: '62701',
};
const WINDOW = {
  start: '2026-10-20T13:00:00-04:00',
  end: '2026-10-20T17:00:00-04:00',
};

function jobInput(overrides: Record<string, unknown> = {}) {
  return {
    jobType: 'plumbing',
    window: WINDOW,
    address: ADDRESS,
    contact: { name: 'Luis Garcia', phone: PHONE },
    problem: 'The kitchen sink is leaking under the cabinet.',
    urgency: 'normal',
    accessNotes: 'Gate code 4B',
    ...overrides,
  };
}

describe.skipIf(!dbReachable)('dispatch actions on Postgres', () => {
  const DB = `qvo_dispatch_act_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: Pool;
  let seq = 0;
  const registry = createDispatchActions();

  async function withTenantTx<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_rls_tester');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client as unknown as TenantTx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function insertTenant(label: string): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`, [
      id,
      label,
      `${label}-${id.slice(0, 8)}`,
    ]);
    return id;
  }

  function ctx(tenantId: string, extra: Partial<ActionContext> = {}): ActionContext {
    return {
      tenantId,
      actor: { type: 'agent', id: 'agent-1' },
      now: NOW,
      tenantTimezone: TZ,
      callId: 'CA-1',
      ...extra,
    };
  }

  function owner(tenantId: string, extra: Partial<ActionContext> = {}): ActionContext {
    return ctx(tenantId, { actor: { type: 'user', id: 'owner-1', role: 'tenant_owner' }, callId: undefined, ...extra });
  }

  function act(name: string, c: ActionContext, input: unknown): Promise<ActionResult> {
    const idempotencyKey = c.idempotencyKey ?? (name.endsWith('.commit') ? undefined : `key-${++seq}`);
    return runAction(name, { ...c, idempotencyKey }, input, {
      store: postgresActionStore,
      withTenantTx,
      registry,
    });
  }

  function data<T = Record<string, unknown>>(result: ActionResult): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
    return result.data as T;
  }

  function errorOf(result: ActionResult) {
    if (result.ok) throw new Error('expected a failure');
    return result.error;
  }

  async function prepare(tenantId: string, input: Record<string, unknown> = jobInput(), extra: Partial<ActionContext> = {}) {
    return data<{ confirmationToken: string }>(await act(CREATE_JOB_PREPARE, ctx(tenantId, extra), input));
  }

  async function jobs(tenantId: string) {
    const { rows } = await pool.query(
      `SELECT id, status, address, contact_phone, eta_start, eta_end FROM dispatch_jobs WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows;
  }

  async function events(tenantId: string) {
    const { rows } = await pool.query(
      `SELECT event_type, from_status, to_status FROM dispatch_job_events WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows;
  }

  beforeAll(async () => {
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    pool = new Pool({ connectionString: adminUrl(DB)!, max: 8 });
    for (const m of allMigrations()) await applyMigration(pool, m);
    await applyMigration(pool, {
      name: 'platform_rls_tester role',
      sql: `
        DO $$ BEGIN
          CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester;
        GRANT platform_rls_tester TO CURRENT_USER;
      `,
    });
    const warm = await Promise.all(Array.from({ length: 4 }, () => pool.connect()));
    await Promise.all(warm.map((c) => c.query('SELECT 1')));
    for (const c of warm) c.release();
  }, 600_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => {});
  }, 60_000);

  it('replays a commit retried with the same token: one job, one created event', async () => {
    const tenantId = await insertTenant('retry');
    const p = await prepare(tenantId);
    const first = await act(CREATE_JOB_COMMIT, ctx(tenantId), { confirmationToken: p.confirmationToken });
    const retry = await act(CREATE_JOB_COMMIT, ctx(tenantId, { now: new Date(NOW.getTime() + 2_000) }), {
      confirmationToken: p.confirmationToken,
    });
    expect(first.ok).toBe(true);
    expect(retry).toEqual(first);
    expect(await jobs(tenantId)).toHaveLength(1);
    expect(await events(tenantId)).toEqual([expect.objectContaining({ event_type: 'created', to_status: 'pending' })]);
  });

  it('serializes two overlapping commits for the same address into one job (spec §4.4 #4)', async () => {
    const tenantId = await insertTenant('dup');
    const a = await prepare(tenantId, jobInput(), { callId: 'CA-a' });
    const b = await prepare(tenantId, jobInput({ problem: 'Calling again about the same leak' }), { callId: 'CA-b' });
    const results = await Promise.all([
      act(CREATE_JOB_COMMIT, ctx(tenantId, { callId: 'CA-a' }), { confirmationToken: a.confirmationToken }),
      act(CREATE_JOB_COMMIT, ctx(tenantId, { callId: 'CA-b' }), { confirmationToken: b.confirmationToken }),
    ]);
    const ok = results.filter((r) => r.ok).map((r) => data<{ jobId: string; duplicate: boolean }>(r));
    expect(ok).toHaveLength(2);
    expect(new Set(ok.map((r) => r.jobId)).size).toBe(1);
    expect(ok.filter((r) => r.duplicate)).toHaveLength(1);
    expect(ok.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await jobs(tenantId)).toHaveLength(1);
    expect((await events(tenantId)).filter((e) => e.event_type === 'created')).toHaveLength(1);
  });

  it('does not dedupe a job in another tenant at the same address', async () => {
    const a = await insertTenant('iso-a');
    const b = await insertTenant('iso-b');
    const pa = await prepare(a);
    const pb = await prepare(b);
    data(await act(CREATE_JOB_COMMIT, ctx(a), { confirmationToken: pa.confirmationToken }));
    const other = data<{ duplicate: boolean }>(
      await act(CREATE_JOB_COMMIT, ctx(b), { confirmationToken: pb.confirmationToken }),
    );
    expect(other.duplicate).toBe(false);
    expect(await jobs(a)).toHaveLength(1);
    expect(await jobs(b)).toHaveLength(1);
  });

  it('lets one of two concurrent status updates win; the other gets CONFLICT', async () => {
    const tenantId = await insertTenant('race');
    const p = await prepare(tenantId);
    const { jobId } = data<{ jobId: string }>(
      await act(CREATE_JOB_COMMIT, ctx(tenantId), { confirmationToken: p.confirmationToken }),
    );
    const results = await Promise.all([
      act(UPDATE_STATUS, owner(tenantId, { idempotencyKey: 'u-a' }), { jobId, status: 'assigned' }),
      act(UPDATE_STATUS, owner(tenantId, { idempotencyKey: 'u-b' }), { jobId, status: 'assigned' }),
    ]);
    const codes = results.map((r) => (r.ok ? 'ok' : r.error.code)).sort();
    expect(codes).toEqual(['CONFLICT', 'ok']);
    const rows = await jobs(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('assigned');
    expect((await events(tenantId)).filter((e) => e.event_type === 'status_change')).toHaveLength(1);
  });

  it('returns NOT_FOUND across tenants for get_job_status and update_status', async () => {
    const a = await insertTenant('nf-a');
    const b = await insertTenant('nf-b');
    const p = await prepare(a);
    const { jobId } = data<{ jobId: string }>(await act(CREATE_JOB_COMMIT, ctx(a), { confirmationToken: p.confirmationToken }));
    await pool.query(`INSERT INTO call_sessions (id, tenant_id, caller_number) VALUES ($1, $2, $3)`, [
      'CA-1',
      a,
      PHONE,
    ]);
    const getA = data(await act(GET_JOB_STATUS, ctx(a), { phone: PHONE, name: 'Luis' }));
    expect(getA).toMatchObject({ status: 'pending' });
    expect(JSON.stringify(getA)).not.toContain(jobId);

    const getB = errorOf(await act(GET_JOB_STATUS, owner(b), { phone: PHONE, name: 'Luis' }));
    expect(getB.code).toBe('NOT_FOUND');
    expect(getB.callerSafeMessage).toBe("I couldn't find a job for that name and number.");

    const patchB = errorOf(
      await act(UPDATE_STATUS, owner(b, { idempotencyKey: 'x' }), { jobId, status: 'assigned' }),
    );
    expect(patchB.code).toBe('NOT_FOUND');
    expect((await jobs(a))[0].status).toBe('pending');
  });

  it('hides a job from an agent whose caller ID does not match (spec §4.4 #7)', async () => {
    const tenantId = await insertTenant('cid');
    const p = await prepare(tenantId);
    data(await act(CREATE_JOB_COMMIT, ctx(tenantId), { confirmationToken: p.confirmationToken }));
    await pool.query(`INSERT INTO call_sessions (id, tenant_id, caller_number) VALUES ($1, $2, $3)`, [
      'CA-other',
      tenantId,
      '+15555550100',
    ]);
    const hidden = errorOf(
      await act(GET_JOB_STATUS, ctx(tenantId, { callId: 'CA-other' }), { phone: PHONE, name: 'Luis' }),
    );
    expect(hidden.code).toBe('NOT_FOUND');
    expect(hidden.callerSafeMessage).toBe("I couldn't find a job for that name and number.");
  });

  it('rejects out-of-range input without writing a row', async () => {
    const tenantId = await insertTenant('range');
    const bad = errorOf(
      await act(CREATE_JOB_PREPARE, ctx(tenantId), jobInput({ problem: 'x'.repeat(2001) })),
    );
    expect(bad.code).toBe('VALIDATION_FAILED');
    expect(await jobs(tenantId)).toHaveLength(0);
  });
});
