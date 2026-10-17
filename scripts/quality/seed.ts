import type { BookingRow, EndSnapshot, TemplateId, TicketRow, TransferRow, WaitlistRow } from './types';

export type StaffMember = { id: string; displayName: string; serviceIds: string[] };
export type Service = { id: string; name: string; durationMin: number; priceText: string };
export type Slot = { start: string; end: string; staffId: string };

export type TenantState = {
  tenantId: string;
  timezone: string;
  template: TemplateId;
  transferTarget: string;
  address: string;
  hoursText: string;
  staff: StaffMember[];
  services: Service[];
  slots: Slot[];
  nextOpenDate?: string;
  reasonIfNoneToday?: 'closed' | 'fully_booked' | 'outside_lead_time' | 'staff_off';
  bookings: BookingRow[];
  tickets: TicketRow[];
  transfers: TransferRow[];
  waitlist: WaitlistRow[];
  holds: Record<
    string,
    {
      kind: 'booking' | 'reschedule' | 'cancel' | 'ticket' | 'transfer';
      payload: Record<string, unknown>;
      readback: string;
      callId?: string;
    }
  >;
  /**
   * Trusted caller ID of the call under test, standing in for
   * call_sessions.caller_number (E.164; null or absent = blocked). Set from
   * the seed, or from the scenario's `callerId` by the runner.
   */
  callerNumber?: string | null;
  /** scheduling_booking_rules.cancellation_window_hours; defaults to 24 like the column. */
  cancellationWindowHours?: number;
};

export interface TenantStore {
  readonly kind: 'memory' | 'postgres';
  state: TenantState;
  seed(name: string): Promise<TenantState>;
  snapshot(): EndSnapshot;
  flush?(): Promise<void>;
  close(): Promise<void>;
}

const TIMEZONE = 'America/New_York';

function baseShop(template: TemplateId, seed: string): Omit<
  TenantState,
  'slots' | 'reasonIfNoneToday' | 'nextOpenDate'
> {
  return {
    tenantId: `tenant-${seed}`,
    timezone: TIMEZONE,
    template,
    transferTarget: 'Dana',
    address: '14 Mercer Street',
    hoursText: 'Tuesday to Saturday, 9 to 6',
    staff: [
      { id: 'marco', displayName: 'Marco', serviceIds: ['mens-cut', 'beard'] },
      { id: 'dana', displayName: 'Dana', serviceIds: ['mens-cut'] },
    ],
    services: [
      { id: 'mens-cut', name: "men's cut", durationMin: 30, priceText: 'from $45' },
      { id: 'beard', name: 'beard trim', durationMin: 15, priceText: '$20' },
    ],
    bookings: [],
    tickets: [],
    transfers: [],
    waitlist: [],
    holds: {},
  };
}

const FIXTURES: Record<string, () => TenantState> = {
  'barbershop-marco': () => ({
    ...baseShop('barbershop', 'barbershop-marco'),
    slots: [
      { start: '2026-10-20T15:30:00-04:00', end: '2026-10-20T16:00:00-04:00', staffId: 'marco' },
      { start: '2026-10-20T16:00:00-04:00', end: '2026-10-20T16:30:00-04:00', staffId: 'dana' },
    ],
  }),
  'barbershop-fully-booked-today': () => ({
    ...baseShop('barbershop', 'barbershop-fully-booked-today'),
    slots: [{ start: '2026-10-21T10:00:00-04:00', end: '2026-10-21T10:30:00-04:00', staffId: 'marco' }],
    reasonIfNoneToday: 'fully_booked',
    nextOpenDate: '2026-10-21',
  }),
  'nail-salon-front-desk': () => ({
    ...baseShop('nail_salon', 'nail-salon-front-desk'),
    staff: [
      { id: 'dana', displayName: 'Dana', serviceIds: ['gel-mani'] },
      { id: 'linh', displayName: 'Linh', serviceIds: ['gel-mani'] },
    ],
    services: [{ id: 'gel-mani', name: 'gel manicure', durationMin: 45, priceText: 'from $55' }],
    slots: [{ start: '2026-10-20T15:30:00-04:00', end: '2026-10-20T16:15:00-04:00', staffId: 'linh' }],
  }),
};

export function listFixtureNames(): string[] {
  return Object.keys(FIXTURES);
}

export function buildFixture(name: string): TenantState {
  const factory = FIXTURES[name];
  if (!factory) {
    throw new Error(`unknown quality-sim seed ${name}; known: ${listFixtureNames().join(', ')}`);
  }
  return factory();
}

/**
 * Holds that were released before ever becoming a booking (superseded by a
 * correction, or expired) are not bookings; the end state leaves them out.
 */
const RELEASED_HOLD_REASONS = new Set(['hold_superseded', 'hold_expired']);

export function isReleasedHold(row: BookingRow): boolean {
  return row.status === 'cancelled' && RELEASED_HOLD_REASONS.has(row.cancellationReason ?? '');
}

/**
 * Rows the end state leaves out: released holds, and an original a
 * reschedule replaced (status 'rescheduled'; its replacement is the booking).
 */
export function isSupersededRow(row: BookingRow): boolean {
  return isReleasedHold(row) || row.status === 'rescheduled';
}

export function snapshotOf(state: TenantState): EndSnapshot {
  return {
    bookings: state.bookings.filter((row) => !isSupersededRow(row)).map((row) => ({ ...row })),
    tickets: state.tickets.map((row) => ({ ...row })),
    transfers: state.transfers.map((row) => ({ ...row })),
    waitlist: state.waitlist.map((row) => ({ ...row })),
  };
}

export class MemoryTenantStore implements TenantStore {
  readonly kind = 'memory' as const;
  state: TenantState;

  constructor(seedName = 'barbershop-marco') {
    this.state = buildFixture(seedName);
  }

  async seed(name: string): Promise<TenantState> {
    this.state = buildFixture(name);
    return this.state;
  }

  snapshot(): EndSnapshot {
    return snapshotOf(this.state);
  }

  async close(): Promise<void> {
    // in-memory
  }
}

type PgClient = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
  end: () => Promise<void>;
};

/**
 * Disposable Postgres-backed store. Used when QUALITY_SIM_POSTGRES=1 and a
 * database URL is present. Scenario state lives in a TEMP table so nothing
 * lands in product schemas (PR-01 owns those). Falls back is the caller's job.
 */
export class PostgresTenantStore implements TenantStore {
  readonly kind = 'postgres' as const;
  state: TenantState;

  constructor(
    private readonly client: PgClient,
    seedName: string,
  ) {
    this.state = buildFixture(seedName);
  }

  static async connect(url: string, seedName: string): Promise<PostgresTenantStore> {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`
      CREATE TEMP TABLE quality_sim_state (
        k text PRIMARY KEY,
        v jsonb NOT NULL
      )
    `);
    const store = new PostgresTenantStore(client, seedName);
    await store.flush();
    return store;
  }

  async seed(name: string): Promise<TenantState> {
    this.state = buildFixture(name);
    await this.flush();
    return this.state;
  }

  snapshot(): EndSnapshot {
    return snapshotOf(this.state);
  }

  async flush(): Promise<void> {
    await this.client.query(
      `INSERT INTO quality_sim_state(k, v) VALUES ('state', $1::jsonb)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
      [JSON.stringify(this.state)],
    );
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export async function createTenantStore(opts?: {
  seed?: string;
  databaseUrl?: string | null;
  preferPostgres?: boolean;
}): Promise<TenantStore> {
  const seed = opts?.seed ?? 'barbershop-marco';
  const prefer = opts?.preferPostgres ?? process.env.QUALITY_SIM_POSTGRES === '1';
  const url = opts?.databaseUrl ?? process.env.QUALITY_SIM_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
  if (prefer && url) {
    return PostgresTenantStore.connect(url, seed);
  }
  return new MemoryTenantStore(seed);
}
