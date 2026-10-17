// Seed the `demo` tenant as "Sharp Line Barbers", a small bilingual barbershop,
// so scheduling.list_services / check_availability return real data on the
// demo line (live call Oct 17: the tenant had no services, barbers or hours).
//
// NOT a migration. Run by hand (Wayne or a bot) after the PR that adds
// migration 125 is merged and applied:
//
//   npx tsx scripts/seed-demo-barbershop.ts --tenant demo --dry-run
//   npx tsx scripts/seed-demo-barbershop.ts --tenant demo
//
// Connection: DATABASE_URL_PRIVILEGED, else DATABASE_URL (APP_ENV=development)
// or PLATFORM_DB_POOL_URL (other APP_ENV), like scripts/seed-demo.ts.
//
// Idempotent: every row has a stable id derived from (tenant, kind, key), and
// every write is an upsert, so a re-run updates in place and never
// duplicates. For the seeded barbers, links and weekly schedules not in the
// plan are removed; the tenant's business hours are replaced by the plan
// (Tue–Sat 9–7, closed Sun/Mon). Nothing else in the tenant is touched.
//
// Refuses to run when the tenant does not exist, or is not a demo tenant
// (tenants.is_demo) unless --allow-non-demo is passed. Uses only QVO tables.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { formatCurrency } from '../platform/core/formatCurrency';
import { withTenantContext } from '../platform/db';
import { serviceAliases, type ServiceKey } from '../shared/scheduling/serviceLexicon';

export const DEFAULT_TENANT_ID = 'demo';
const SHOP_NAME = 'Sharp Line Barbers';
const SHOP_TIMEZONE = 'America/New_York';

export interface QueryClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

type PriceKind = 'fixed' | 'from' | 'hidden';

export interface PlannedService {
  id: string;
  key: ServiceKey;
  name: string;
  description: string;
  durationMin: number;
  bufferMin: number;
  priceKind: PriceKind;
  /** null = the shop will confirm the price. */
  priceCents: number | null;
  aliases: string[];
}

export interface PlannedProvider {
  id: string;
  name: string;
  specialty: string;
  languages: string[];
  serviceKeys: ServiceKey[];
  /** 0 = Sunday … 6 = Saturday. */
  workDays: number[];
}

export interface PlannedSchedule {
  id: string;
  providerId: string;
  dayOfWeek: number;
  start: string;
  end: string;
}

export interface SeedPlan {
  tenantId: string;
  services: PlannedService[];
  providers: PlannedProvider[];
  providerServices: { providerId: string; serviceId: string }[];
  schedules: PlannedSchedule[];
  businessHours: { dayOfWeek: number; open: string; close: string }[];
  bookingRule: {
    id: string;
    minLeadTimeHours: number;
    maxLeadTimeDays: number;
    allowSameDay: boolean;
    cancellationWindowHours: number;
  };
}

/** Stable UUID-shaped id (name-based, SHA-1, RFC 4122 v5 layout). */
export function stableId(tenantId: string, kind: string, key: string): string {
  const hex = createHash('sha1').update(`seed-demo-barbershop:${tenantId}:${kind}:${key}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const OPEN_DAYS = [2, 3, 4, 5, 6]; // Tue–Sat
const OPEN = '09:00';
const CLOSE = '19:00';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SERVICES: Omit<PlannedService, 'id' | 'aliases'>[] = [
  { key: 'haircut', name: 'Haircut', description: 'Classic clipper or scissor cut.', durationMin: 30, bufferMin: 5, priceKind: 'from', priceCents: 3000 },
  { key: 'fade', name: 'Fade', description: 'Skin, bald, low, mid or high fade.', durationMin: 45, bufferMin: 5, priceKind: 'from', priceCents: 3500 },
  { key: 'taper', name: 'Taper', description: 'Low or high taper on the sides and back.', durationMin: 45, bufferMin: 5, priceKind: 'from', priceCents: 3500 },
  { key: 'lineup', name: 'Lineup', description: 'Shape-up of the hairline and edges.', durationMin: 15, bufferMin: 0, priceKind: 'fixed', priceCents: 1500 },
  { key: 'beard_trim', name: 'Beard trim', description: 'Beard trim and line-up.', durationMin: 15, bufferMin: 0, priceKind: 'fixed', priceCents: 1500 },
  { key: 'cut_and_beard', name: 'Haircut and beard', description: 'Haircut plus beard trim.', durationMin: 45, bufferMin: 5, priceKind: 'from', priceCents: 4500 },
  // No price on purpose: the agent says "the shop will confirm the price".
  { key: 'hot_towel_shave', name: 'Hot towel shave', description: 'Straight razor shave with a hot towel.', durationMin: 30, bufferMin: 5, priceKind: 'hidden', priceCents: null },
  { key: 'kids_cut', name: 'Kids cut', description: 'Kids 12 and under.', durationMin: 30, bufferMin: 5, priceKind: 'fixed', priceCents: 2000 },
];

const ALL_KEYS = SERVICES.map((s) => s.key);

const PROVIDERS: Omit<PlannedProvider, 'id'>[] = [
  { name: 'Marcus', specialty: 'Master barber', languages: ['en'], serviceKeys: ALL_KEYS, workDays: OPEN_DAYS },
  {
    name: 'Luis',
    specialty: 'Barber (English / Español)',
    languages: ['en', 'es'],
    serviceKeys: ALL_KEYS.filter((k) => k !== 'hot_towel_shave'),
    workDays: OPEN_DAYS,
  },
  {
    name: 'Dee',
    specialty: 'Barber',
    languages: ['en'],
    serviceKeys: ['haircut', 'fade', 'taper', 'lineup', 'kids_cut'],
    workDays: OPEN_DAYS.filter((d) => d !== 3), // off Wednesday
  },
];

export function buildDemoBarbershopPlan(tenantId: string = DEFAULT_TENANT_ID): SeedPlan {
  const services = SERVICES.map((s) => ({
    ...s,
    id: stableId(tenantId, 'service', s.key),
    aliases: serviceAliases(s.key).filter((a) => a.toLowerCase() !== s.name.toLowerCase()),
  }));
  const serviceId = new Map(services.map((s) => [s.key, s.id]));
  const providers = PROVIDERS.map((p) => ({ ...p, id: stableId(tenantId, 'provider', p.name.toLowerCase()) }));
  return {
    tenantId,
    services,
    providers,
    providerServices: providers.flatMap((p) => p.serviceKeys.map((k) => ({ providerId: p.id, serviceId: serviceId.get(k)! }))),
    schedules: providers.flatMap((p) =>
      p.workDays.map((day) => ({
        id: stableId(tenantId, 'schedule', `${p.name.toLowerCase()}:${day}`),
        providerId: p.id,
        dayOfWeek: day,
        start: OPEN,
        end: CLOSE,
      }))),
    businessHours: OPEN_DAYS.map((day) => ({ dayOfWeek: day, open: OPEN, close: CLOSE })),
    bookingRule: {
      id: stableId(tenantId, 'booking_rule', 'tenant'),
      minLeadTimeHours: 1,
      maxLeadTimeDays: 30,
      allowSameDay: true,
      cancellationWindowHours: 24,
    },
  };
}

function money(cents: number | null, kind: PriceKind): string {
  if (cents === null || kind === 'hidden') return 'price: shop confirms';
  const dollars = formatCurrency(cents, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return kind === 'from' ? `from ${dollars}` : dollars;
}

/** Human-readable list of the upserts the plan makes. */
export function describePlan(plan: SeedPlan): string[] {
  const names = new Map(plan.services.map((s) => [s.id, s.name]));
  const lines = [`Tenant ${plan.tenantId}: ${SHOP_NAME}`];
  lines.push(`scheduling_appointment_types (${plan.services.length}):`);
  for (const s of plan.services) {
    lines.push(`  upsert ${s.id} ${s.name}, ${s.durationMin} min (+${s.bufferMin} buffer), ${money(s.priceCents, s.priceKind)}; aliases: ${s.aliases.join(', ')}`);
  }
  lines.push(`scheduling_providers (${plan.providers.length}):`);
  for (const p of plan.providers) {
    const services = p.serviceKeys.length === plan.services.length ? 'all services' : plan.providerServices
      .filter((l) => l.providerId === p.id)
      .map((l) => names.get(l.serviceId))
      .join(', ');
    lines.push(`  upsert ${p.id} ${p.name} (${p.languages.join('/')}), ${p.workDays.map((d) => DAY_NAMES[d]).join(' ')} ${OPEN}–${CLOSE}; ${services}`);
  }
  lines.push(`scheduling_provider_services: ${plan.providerServices.length} links`);
  lines.push(`scheduling_provider_schedules: ${plan.schedules.length} weekly blocks`);
  lines.push(`scheduling_business_hours (replaced): ${plan.businessHours.map((h) => DAY_NAMES[h.dayOfWeek]).join(' ')} ${OPEN}–${CLOSE}; closed Sun, Mon`);
  const r = plan.bookingRule;
  lines.push(`scheduling_booking_rules (tenant-wide): lead ${r.minLeadTimeHours} h, up to ${r.maxLeadTimeDays} days ahead, same day ${r.allowSameDay ? 'yes' : 'no'}, cancel window ${r.cancellationWindowHours} h; slot grid = engine default 15 min`);
  return lines;
}

export interface SeedOptions {
  tenantId?: string;
  dryRun?: boolean;
  /** Allow a tenant whose tenants.is_demo is not true. */
  allowNonDemo?: boolean;
  log?: (line: string) => void;
}

export interface SeedResult {
  tenantId: string;
  dryRun: boolean;
  services: number;
  providers: number;
  providerServices: number;
  schedules: number;
  businessHours: number;
}

async function writePlan(client: QueryClient, plan: SeedPlan): Promise<void> {
  const t = plan.tenantId;

  for (const s of plan.services) {
    await client.query(
      `INSERT INTO scheduling_appointment_types
         (id, tenant_id, name, description, duration_minutes, buffer_minutes, price_kind, price_cents, aliases, is_active, allow_self_scheduling)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], true, false)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         duration_minutes = EXCLUDED.duration_minutes,
         buffer_minutes = EXCLUDED.buffer_minutes,
         price_kind = EXCLUDED.price_kind,
         price_cents = EXCLUDED.price_cents,
         price_max_cents = NULL,
         aliases = EXCLUDED.aliases,
         is_active = true,
         updated_at = NOW()
       WHERE scheduling_appointment_types.tenant_id = EXCLUDED.tenant_id`,
      [s.id, t, s.name, s.description, s.durationMin, s.bufferMin, s.priceKind, s.priceCents, s.aliases],
    );
  }

  for (const p of plan.providers) {
    await client.query(
      `INSERT INTO scheduling_providers (id, tenant_id, name, specialty, is_active, metadata)
       VALUES ($1, $2, $3, $4, true, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         specialty = EXCLUDED.specialty,
         is_active = true,
         metadata = COALESCE(scheduling_providers.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = NOW()
       WHERE scheduling_providers.tenant_id = EXCLUDED.tenant_id`,
      [p.id, t, p.name, p.specialty, JSON.stringify({ languages: p.languages, seededBy: 'seed-demo-barbershop' })],
    );
  }

  const providerIds = plan.providers.map((p) => p.id);
  await client.query(
    `DELETE FROM scheduling_provider_services
      WHERE tenant_id = $1
        AND provider_id = ANY($2::text[])
        AND (provider_id, appointment_type_id) NOT IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
    [t, providerIds, plan.providerServices.map((l) => l.providerId), plan.providerServices.map((l) => l.serviceId)],
  );
  for (const link of plan.providerServices) {
    await client.query(
      `INSERT INTO scheduling_provider_services (tenant_id, provider_id, appointment_type_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider_id, appointment_type_id) DO NOTHING`,
      [t, link.providerId, link.serviceId],
    );
  }

  await client.query(
    `DELETE FROM scheduling_provider_schedules
      WHERE tenant_id = $1 AND provider_id = ANY($2::text[]) AND id <> ALL($3::text[])`,
    [t, providerIds, plan.schedules.map((s) => s.id)],
  );
  for (const s of plan.schedules) {
    await client.query(
      `INSERT INTO scheduling_provider_schedules (id, tenant_id, provider_id, day_of_week, start_time, end_time, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (id) DO UPDATE SET
         day_of_week = EXCLUDED.day_of_week,
         start_time = EXCLUDED.start_time,
         end_time = EXCLUDED.end_time,
         is_active = true
       WHERE scheduling_provider_schedules.tenant_id = EXCLUDED.tenant_id`,
      [s.id, t, s.providerId, s.dayOfWeek, s.start, s.end],
    );
  }

  await client.query(
    `DELETE FROM scheduling_business_hours
      WHERE tenant_id = $1
        AND (day_of_week, open_time) NOT IN (SELECT * FROM unnest($2::int[], $3::time[]))`,
    [t, plan.businessHours.map((h) => h.dayOfWeek), plan.businessHours.map((h) => h.open)],
  );
  for (const h of plan.businessHours) {
    await client.query(
      `INSERT INTO scheduling_business_hours (tenant_id, day_of_week, open_time, close_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, day_of_week, open_time) DO UPDATE SET
         close_time = EXCLUDED.close_time,
         updated_at = NOW()`,
      [t, h.dayOfWeek, h.open, h.close],
    );
  }

  // One tenant-wide rule row. Update the tenant's existing one if it has
  // one (the loader reads the first), else insert ours.
  const r = plan.bookingRule;
  const updated = await client.query(
    `UPDATE scheduling_booking_rules SET
       min_lead_time_hours = $2, max_lead_time_days = $3, allow_same_day = $4,
       allow_double_book = false, max_daily_bookings = NULL, cancellation_window_hours = $5,
       updated_at = NOW()
     WHERE tenant_id = $1 AND appointment_type_id IS NULL`,
    [t, r.minLeadTimeHours, r.maxLeadTimeDays, r.allowSameDay, r.cancellationWindowHours],
  );
  if (!updated.rowCount) {
    await client.query(
      `INSERT INTO scheduling_booking_rules
         (id, tenant_id, appointment_type_id, min_lead_time_hours, max_lead_time_days, allow_same_day,
          allow_double_book, max_daily_bookings, cancellation_window_hours)
       VALUES ($1, $2, NULL, $3, $4, $5, false, NULL, $6)`,
      [r.id, t, r.minLeadTimeHours, r.maxLeadTimeDays, r.allowSameDay, r.cancellationWindowHours],
    );
  }
}

/**
 * Seed (or, with dryRun, only describe) the barbershop on `client`. Runs in
 * its own transaction bound to the tenant (withTenantContext); a dry run
 * rolls back and writes nothing.
 */
export async function seedDemoBarbershop(client: QueryClient, opts: SeedOptions = {}): Promise<SeedResult> {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? ((line: string) => console.log(line));
  const plan = buildDemoBarbershopPlan(tenantId);

  await client.query('BEGIN');
  try {
    await withTenantContext(client, tenantId, async () => {
      const tenant = await client.query(`SELECT id, is_demo, timezone FROM tenants WHERE id = $1`, [tenantId]);
      const row = tenant.rows[0];
      if (!row) throw new Error(`[SEED] Tenant "${tenantId}" does not exist. Nothing was written.`);
      if (row.is_demo !== true && !opts.allowNonDemo) {
        throw new Error(`[SEED] Tenant "${tenantId}" is not a demo tenant (tenants.is_demo). Pass --allow-non-demo to seed it anyway.`);
      }
      if (row.timezone && row.timezone !== SHOP_TIMEZONE) {
        log(`[SEED] Note: tenant timezone is ${String(row.timezone)}; hours are wall-clock times in that zone (the plan assumes ${SHOP_TIMEZONE}).`);
      }
      for (const line of describePlan(plan)) log(`[SEED]${dryRun ? ' [dry-run]' : ''} ${line}`);
      if (!dryRun) await writePlan(client, plan);
    });
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  log(dryRun ? '[SEED] Dry run: nothing was written.' : `[SEED] ${SHOP_NAME} seeded for tenant ${tenantId}.`);
  return {
    tenantId,
    dryRun,
    services: plan.services.length,
    providers: plan.providers.length,
    providerServices: plan.providerServices.length,
    schedules: plan.schedules.length,
    businessHours: plan.businessHours.length,
  };
}

export function parseSeedArgs(args: string[]): Required<Pick<SeedOptions, 'tenantId' | 'dryRun' | 'allowNonDemo'>> {
  let tenantId = DEFAULT_TENANT_ID;
  let dryRun = false;
  let allowNonDemo = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--allow-non-demo') allowNonDemo = true;
    else if (arg === '--tenant') tenantId = args[++i] ?? '';
    else if (arg.startsWith('--tenant=')) tenantId = arg.slice('--tenant='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!tenantId || tenantId.length > 255 || /[\u0000-\u001f]/.test(tenantId)) {
    throw new Error('--tenant needs a tenant id');
  }
  return { tenantId, dryRun, allowNonDemo };
}

function connectionUrl(): string {
  const env = process.env.APP_ENV ?? 'development';
  const url = process.env.DATABASE_URL_PRIVILEGED
    ?? (env === 'development' ? process.env.DATABASE_URL : process.env.PLATFORM_DB_POOL_URL)
    ?? '';
  if (!url) {
    throw new Error(
      env === 'development'
        ? '[SEED] DATABASE_URL is not set for development.'
        : '[SEED] PLATFORM_DB_POOL_URL is not set for production/staging.',
    );
  }
  return url;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const opts = parseSeedArgs(args);
  const env = process.env.APP_ENV ?? 'development';
  console.log(`[SEED] Environment: ${env}`);
  const pool = new pg.Pool({
    connectionString: connectionUrl(),
    max: 1,
    ...(env !== 'development' ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  const client = await pool.connect();
  try {
    await seedDemoBarbershop(client as unknown as QueryClient, opts);
  } finally {
    client.release();
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : '[SEED] Failed');
    process.exitCode = 1;
  });
}
