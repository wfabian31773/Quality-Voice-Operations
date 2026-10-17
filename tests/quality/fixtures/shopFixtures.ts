/**
 * Shop seed fixtures for the vertical1 scenario pack (PR-12).
 *
 * `scripts/quality/seed.ts` hardcodes its seeds, so the vertical1 pack brings
 * its own: YAML fixtures in this directory are expanded into the harness's
 * `TenantState` (weekly hours + staff days off → concrete slots) and served
 * through `ShopFixtureStore`, which `runScenarios({ store })` accepts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatLocalHm } from '../../../scripts/quality/fakeToolProvider';
import { snapshotOf, type Service, type Slot, type StaffMember, type TenantState, type TenantStore } from '../../../scripts/quality/seed';
import { loadYaml } from '../../../scripts/quality/yaml';
import type { BookingRow, EndSnapshot, TemplateId } from '../../../scripts/quality/types';

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SHOP_FIXTURE_FILES = ['barbershop-basic', 'nail-salon-basic'] as const;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type Weekday = (typeof WEEKDAYS)[number];

type FixtureBooking = Omit<BookingRow, 'staffName' | 'startLocal'>;

export type SmsSettings = { messagingEnabled: boolean; optedOut: string[] };

type FixtureVariant = {
  bookings?: FixtureBooking[];
  dropSlotsOn?: string[];
  reasonIfNoneToday?: TenantState['reasonIfNoneToday'];
  nextOpenDate?: string;
  sms?: SmsSettings;
  transferHours?: TransferHours;
  /** Services this variant's slots are sized for; overrides `slotServiceIds`. */
  slotServiceIds?: string[];
  /**
   * The call's trusted caller ID (call_sessions.caller_number; null = blocked).
   * A scenario's `callerId` overrides it.
   */
  callerNumber?: string | null;
};

export type TransferHours = { days: Weekday[] };

/** `bufferMin`: minutes blocked after the service (tools-spec §1 catalog); defaults to 0. */
export type FixtureService = Service & { bufferMin?: number };

export type ShopFixture = {
  name: string;
  template: TemplateId;
  timezone: string;
  transferTarget: string;
  address: string;
  hoursText: string;
  hours: Partial<Record<Weekday, [string, string]>>;
  /** The booking each slot is sized for: end = start + its durations and buffers. */
  slotServiceIds: string[];
  openTimes: string[];
  dateRange: { from: string; to: string };
  staff: Array<StaffMember & { daysOff?: Weekday[] }>;
  services: FixtureService[];
  sms: SmsSettings;
  transferHours: TransferHours;
  /** scheduling_booking_rules.cancellation_window_hours (reschedule/cancel policy). */
  cancellationWindowHours: number;
  variants?: Record<string, FixtureVariant>;
};

export type ShopTenantState = TenantState & { sms: SmsSettings; transferHours: TransferHours };

const cache = new Map<string, ShopFixture>();

export function loadShopFixture(file: string): ShopFixture {
  const hit = cache.get(file);
  if (hit) return hit;
  const raw = loadYaml(readFileSync(path.join(FIXTURE_DIR, `${file}.yaml`), 'utf8')) as ShopFixture;
  cache.set(file, raw);
  return raw;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toMinutes(hm: string): number {
  const [hour, minute] = hm.split(':').map(Number);
  return hour * 60 + minute;
}

function fromMinutes(total: number): string {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - utcMs) / 60000);
}

/** Local wall time in `timeZone` → ISO string with the DST-correct offset. */
export function zonedIso(date: string, hm: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = hm.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = offsetMinutesAt(guess - offsetMinutesAt(guess, timeZone) * 60000, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${date}T${hm}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function weekdayOf(date: string): Weekday {
  const [year, month, day] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let ms = Date.UTC(fy, fm - 1, fd); ms <= end; ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

/** Minutes a booking of `serviceIds` blocks: each service's duration plus its buffer. */
export function bookingMinutes(fixture: ShopFixture, serviceIds: string[]): number {
  if (serviceIds.length === 0) throw new Error(`${fixture.name}: slots need at least one service`);
  return serviceIds.reduce((total, id) => {
    const service = fixture.services.find((row) => row.id === id);
    if (!service) throw new Error(`${fixture.name}: unknown service ${id}`);
    return total + service.durationMin + (service.bufferMin ?? 0);
  }, 0);
}

/** Local end time (HH:MM) of a booking of `serviceIds` that starts at `start`. */
export function slotEnd(fixture: ShopFixture, start: string, serviceIds: string[]): string {
  return fromMinutes(toMinutes(start) + bookingMinutes(fixture, serviceIds));
}

/**
 * Slots sized for `serviceIds` (default: the fixture's `slotServiceIds`).
 * `FakeToolProvider` returns `slot.end` verbatim, so a scenario that books other
 * services needs a variant whose `slotServiceIds` match them. Starts whose whole
 * interval would run past closing are dropped.
 */
export function buildSlots(fixture: ShopFixture, dropOn: string[] = [], serviceIds = fixture.slotServiceIds): Slot[] {
  const minutes = bookingMinutes(fixture, serviceIds);
  const slots: Slot[] = [];
  for (const date of eachDate(fixture.dateRange.from, fixture.dateRange.to)) {
    if (dropOn.includes(date)) continue;
    const weekday = weekdayOf(date);
    const hours = fixture.hours[weekday];
    if (!hours) continue;
    const [open, close] = hours.map(toMinutes);
    for (const hm of fixture.openTimes) {
      const start = toMinutes(hm);
      const end = start + minutes;
      if (start < open || end > close) continue;
      for (const member of fixture.staff) {
        if (member.daysOff?.includes(weekday)) continue;
        slots.push({
          start: zonedIso(date, hm, fixture.timezone),
          end: zonedIso(date, fromMinutes(end), fixture.timezone),
          staffId: member.id,
        });
      }
    }
  }
  return slots;
}

export function listShopFixtureNames(): string[] {
  return SHOP_FIXTURE_FILES.flatMap((file) => {
    const fixture = loadShopFixture(file);
    return [file, ...Object.keys(fixture.variants ?? {}).map((variant) => `${file}:${variant}`)];
  });
}

const built = new Map<string, ShopTenantState>();

/** Fresh, mutable tenant state for `seedName`; the expanded slots are built once per seed. */
export function buildShopFixture(seedName: string): ShopTenantState {
  let state = built.get(seedName);
  if (!state) {
    state = expandShopFixture(seedName);
    built.set(seedName, state);
  }
  return structuredClone(state);
}

function expandShopFixture(seedName: string): ShopTenantState {
  const [file, variantName] = seedName.split(':');
  if (!(SHOP_FIXTURE_FILES as readonly string[]).includes(file)) {
    throw new Error(`unknown shop fixture ${seedName}; known: ${listShopFixtureNames().join(', ')}`);
  }
  const fixture = loadShopFixture(file);
  const variant: FixtureVariant | undefined = variantName ? fixture.variants?.[variantName] : {};
  if (!variant) {
    throw new Error(`unknown shop fixture ${seedName}; known: ${listShopFixtureNames().join(', ')}`);
  }
  const staff = fixture.staff.map(({ id, displayName, serviceIds }) => ({ id, displayName, serviceIds: [...serviceIds] }));
  const bookings: BookingRow[] = (variant.bookings ?? []).map((row) => ({
    ...row,
    serviceIds: [...row.serviceIds],
    staffName: staff.find((member) => member.id === row.staffId)?.displayName ?? row.staffId,
    startLocal: formatLocalHm(row.start, fixture.timezone),
  }));
  return {
    tenantId: `tenant-${file}`,
    timezone: fixture.timezone,
    template: fixture.template,
    transferTarget: fixture.transferTarget,
    address: fixture.address,
    hoursText: fixture.hoursText,
    staff,
    services: fixture.services.map(({ bufferMin: _bufferMin, ...service }) => service),
    slots: buildSlots(fixture, variant.dropSlotsOn, variant.slotServiceIds),
    nextOpenDate: variant.nextOpenDate,
    reasonIfNoneToday: variant.reasonIfNoneToday,
    bookings,
    tickets: [],
    transfers: [],
    waitlist: [],
    holds: {},
    callerNumber: variant.callerNumber ?? null,
    cancellationWindowHours: fixture.cancellationWindowHours,
    sms: { ...(variant.sms ?? fixture.sms) },
    transferHours: { ...(variant.transferHours ?? fixture.transferHours) },
  };
}

/** In-memory store seeded from the shop fixtures; pass as `runScenarios(..., { store })`. */
export class ShopFixtureStore implements TenantStore {
  readonly kind = 'memory' as const;
  state: TenantState;

  constructor(seedName = 'barbershop-basic') {
    this.state = buildShopFixture(seedName);
  }

  async seed(name: string): Promise<TenantState> {
    this.state = buildShopFixture(name);
    return this.state;
  }

  snapshot(): EndSnapshot {
    return snapshotOf(this.state);
  }

  async close(): Promise<void> {
    // in-memory
  }
}
