// @vitest-environment node
// scripts/seed-demo-barbershop.ts against a throwaway local Postgres
// (migrations 001..125): runs the seed twice, checks nothing is duplicated,
// then asks the availability engine for a Saturday-morning "fade" resolved
// through the seeded aliases, as the NOBYPASSRLS tester role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMemoryStore, runAction, type ActionContext, type TenantTx } from '../platform/actions';
import { loadCatalog } from '../platform/actions/scheduling/availability';
import { resolveServiceByName } from '../platform/actions/scheduling/serviceMatch';
import {
  buildDemoBarbershopPlan,
  parseSeedArgs,
  seedDemoBarbershop,
  stableId,
  type QueryClient,
} from './seed-demo-barbershop';

const ADMIN_URL_RAW = process.env.DATABASE_URL ?? process.env.DATABASE_URL_PRIVILEGED ?? 'postgresql://ubuntu@127.0.0.1:5432/postgres';

function adminUrl(database?: string): string | null {
  try {
    const u = new URL(ADMIN_URL_RAW);
    // Throwaway local databases only.
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

function migrationsThrough(maxPrefix: string): { name: string; sql: string }[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql')).sort();
  // Same ordering fix as platform/actions/scheduling/postgres.integration.test.ts.
  const iPins = files.indexOf('063_call_saved_view_pins.sql');
  const iPinOrder = files.indexOf('063_call_saved_views_pin_order.sql');
  if (iPins >= 0 && iPinOrder >= 0 && iPins < iPinOrder) {
    files.splice(iPinOrder, 1);
    files.splice(iPins, 0, '063_call_saved_views_pin_order.sql');
  }
  return files
    .filter((name) => name.slice(0, 3) <= maxPrefix)
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
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

/** One transaction per file, like scripts/run-migrations.ts (retries cluster-wide role DDL races). */
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

// Sat Oct 17 2026, 2:17 PM EDT: the moment of the live test call.
const CALL_TIME = new Date('2026-10-17T18:17:00Z');
const quiet = () => {};

describe('seed-demo-barbershop CLI args', () => {
  it('defaults to tenant demo and accepts --tenant both ways', () => {
    expect(parseSeedArgs([])).toEqual({ tenantId: 'demo', dryRun: false, allowNonDemo: false });
    expect(parseSeedArgs(['--tenant', 'abc', '--dry-run'])).toEqual({ tenantId: 'abc', dryRun: true, allowNonDemo: false });
    expect(parseSeedArgs(['--tenant=xyz', '--allow-non-demo']).tenantId).toBe('xyz');
    expect(() => parseSeedArgs(['--tenant'])).toThrow(/tenant/);
    expect(() => parseSeedArgs(['--force'])).toThrow(/Unknown argument/);
  });

  it('builds stable, tenant-specific ids', () => {
    expect(stableId('demo', 'service', 'fade')).toBe(stableId('demo', 'service', 'fade'));
    expect(stableId('demo', 'service', 'fade')).not.toBe(stableId('other', 'service', 'fade'));
    expect(stableId('demo', 'service', 'fade')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const plan = buildDemoBarbershopPlan('demo');
    expect(plan.services.map((s) => s.name)).toEqual([
      'Haircut', 'Fade', 'Taper', 'Lineup', 'Beard trim', 'Haircut and beard', 'Hot towel shave', 'Kids cut',
    ]);
    expect(plan.services.find((s) => s.key === 'fade')!.aliases).toEqual(
      expect.arrayContaining(['skin fade', 'bald fade', 'low fade', 'mid fade', 'high fade', 'degradado']),
    );
  });
});

describe.skipIf(!dbReachable)('seed-demo-barbershop on Postgres', () => {
  const DB = `qvo_seed_barber_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: Pool;

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

  async function seed(opts: Parameters<typeof seedDemoBarbershop>[1]) {
    const client = await pool.connect();
    try {
      return await seedDemoBarbershop(client as unknown as QueryClient, { log: quiet, ...opts });
    } finally {
      client.release();
    }
  }

  async function counts(tenantId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of [
      'scheduling_appointment_types',
      'scheduling_providers',
      'scheduling_provider_services',
      'scheduling_provider_schedules',
      'scheduling_business_hours',
      'scheduling_booking_rules',
    ]) {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      out[table] = rows[0].n;
    }
    return out;
  }

  function ctx(tenantId: string): ActionContext {
    return { tenantId, actor: { type: 'agent', id: 'agent-1' }, now: CALL_TIME, tenantTimezone: 'America/New_York' };
  }

  async function read(tenantId: string, name: string, input: unknown) {
    return runAction(name, ctx(tenantId), input, { store: createMemoryStore(), withTenantTx });
  }

  beforeAll(async () => {
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    pool = new Pool({ connectionString: adminUrl(DB)!, max: 4 });
    for (const m of migrationsThrough('125')) await applyMigration(pool, m);
    await applyMigration(pool, {
      name: 'platform_rls_tester role',
      sql: `
        DO $$ BEGIN
          CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester;
        GRANT platform_rls_tester TO CURRENT_USER;
      `,
    });
    await pool.query(
      `INSERT INTO tenants (id, name, slug, status, is_demo, timezone)
       VALUES ('demo', 'Demo Organization', 'demo', 'active', true, 'America/New_York'),
              ('real-shop', 'Real Shop', 'real-shop', 'active', false, 'America/New_York')`,
    );
  }, 600_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => {});
  }, 60_000);

  it('refuses a missing tenant and a non-demo tenant without the flag', async () => {
    await expect(seed({ tenantId: 'no-such-tenant' })).rejects.toThrow(/does not exist/);
    await expect(seed({ tenantId: 'real-shop' })).rejects.toThrow(/not a demo tenant/);
    expect(Object.values(await counts('real-shop')).every((n) => n === 0)).toBe(true);
  });

  it('dry run prints the plan and writes nothing', async () => {
    const lines: string[] = [];
    const result = await seed({ dryRun: true, log: (l) => lines.push(l) });
    expect(result).toMatchObject({ tenantId: 'demo', dryRun: true, services: 8, providers: 3 });
    expect(lines.join('\n')).toMatch(/\[dry-run\] .*Fade, 45 min .*from \$35; aliases: .*skin fade/);
    expect(lines.join('\n')).toMatch(/Hot towel shave, 30 min .*price: shop confirms/);
    expect(lines.join('\n')).toMatch(/Dee \(en\), Tue Thu Fri Sat 09:00–19:00/);
    expect(Object.values(await counts('demo')).every((n) => n === 0)).toBe(true);
  });

  it('seeds the shop, and a second run changes no counts', async () => {
    await seed({});
    const first = await counts('demo');
    expect(first).toEqual({
      scheduling_appointment_types: 8,
      scheduling_providers: 3,
      scheduling_provider_services: 8 + 7 + 5,
      scheduling_provider_schedules: 5 + 5 + 4,
      scheduling_business_hours: 5,
      scheduling_booking_rules: 1,
    });
    await seed({});
    expect(await counts('demo')).toEqual(first);

    const { rows: dupes } = await pool.query(
      `SELECT name, COUNT(*)::int AS n FROM scheduling_appointment_types WHERE tenant_id = 'demo' GROUP BY name HAVING COUNT(*) > 1`,
    );
    expect(dupes).toEqual([]);
    const { rows: hours } = await pool.query(
      `SELECT day_of_week, open_time::text AS open, close_time::text AS close FROM scheduling_business_hours WHERE tenant_id = 'demo' ORDER BY day_of_week`,
    );
    expect(hours).toEqual([2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, open: '09:00:00', close: '19:00:00' })));
    const { rows: rules } = await pool.query(`SELECT min_lead_time_hours, max_lead_time_days FROM scheduling_booking_rules WHERE tenant_id = 'demo'`);
    expect(rules).toEqual([{ min_lead_time_hours: 1, max_lead_time_days: 30 }]);
  });

  it('only affects the seeded tenant, and --allow-non-demo seeds a non-demo tenant with its own ids', async () => {
    expect(Object.values(await counts('real-shop')).every((n) => n === 0)).toBe(true);
    await seed({ tenantId: 'real-shop', allowNonDemo: true });
    expect((await counts('real-shop')).scheduling_appointment_types).toBe(8);
    expect((await counts('demo')).scheduling_appointment_types).toBe(8);
  });

  it('lists the services with aliases and spoken prices', async () => {
    const services = await read('demo', 'scheduling.list_services', {});
    expect(services.ok).toBe(true);
    const list = services.ok ? (services.data as { name: string; durationMin: number; priceText: string | null }[]) : [];
    expect(list.map((s) => [s.name, s.durationMin, s.priceText])).toEqual([
      ['Beard trim', 15, '$15'],
      ['Fade', 45, 'from $35'],
      ['Haircut', 30, 'from $30'],
      ['Haircut and beard', 45, 'from $45'],
      ['Hot towel shave', 30, null],
      ['Kids cut', 30, '$20'],
      ['Lineup', 15, '$15'],
      ['Taper', 45, 'from $35'],
    ]);
    const catalog = await withTenantTx('demo', (tx) => loadCatalog(tx, 'demo'));
    expect(catalog.services.find((s) => s.name === 'Fade')!.aliases).toEqual(expect.arrayContaining(['bald fade', 'degradado']));
  });

  it('returns Saturday-morning slots for a fade resolved through an alias', async () => {
    const catalog = await withTenantTx('demo', (tx) => loadCatalog(tx, 'demo'));
    const match = resolveServiceByName(catalog, 'can I get a low fade Saturday morning');
    expect(match).toMatchObject({ ambiguous: false, matchedBy: 'alias_in_text', service: { name: 'Fade' } });
    expect(resolveServiceByName(catalog, 'quiero un degradado').service?.name).toBe('Fade');
    expect(resolveServiceByName(catalog, 'can I get a shape-up').service?.name).toBe('Lineup');

    const result = await read('demo', 'scheduling.check_availability', {
      serviceIds: [match.service!.id],
      date: '2026-10-24',
      partOfDay: 'morning',
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.ok ? (result.data as { slots: { start: string; end: string; staffName: string }[] }) : { slots: [] };
    expect(data.slots.length).toBeGreaterThan(0);
    // 9:00 AM EDT, 45 minutes.
    expect(data.slots[0]).toMatchObject({ start: '2026-10-24T13:00:00.000Z', end: '2026-10-24T13:45:00.000Z' });
    expect(['Marcus', 'Luis', 'Dee']).toContain(data.slots[0].staffName);
  });

  it('is closed Sunday and Monday, and Dee is off Wednesday', async () => {
    const fade = stableId('demo', 'service', 'fade');
    const sunday = await read('demo', 'scheduling.check_availability', { serviceIds: [fade], date: '2026-10-25' });
    expect(sunday.ok && sunday.data).toMatchObject({ slots: [], reasonIfNone: 'closed', nextOpenDate: '2026-10-27' });
    const dee = stableId('demo', 'provider', 'dee');
    const wednesday = await read('demo', 'scheduling.check_availability', { serviceIds: [fade], staffId: dee, date: '2026-10-21' });
    expect(wednesday.ok && wednesday.data).toMatchObject({ slots: [], reasonIfNone: 'staff_off' });
    const shave = stableId('demo', 'service', 'hot_towel_shave');
    const luisShave = await read('demo', 'scheduling.check_availability', {
      serviceIds: [shave],
      staffId: stableId('demo', 'provider', 'luis'),
      date: '2026-10-24',
    });
    expect(luisShave.ok ? null : luisShave.error.code).toBe('VALIDATION_FAILED');
  });
});
