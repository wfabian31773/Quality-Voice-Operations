import { spokenSlot } from './spoken';
import {
  addDays,
  dateRange,
  dayOfWeek,
  DAY_MINUTES,
  localDateOf,
  localMinuteOf,
  MINUTE_MS,
  offsetMinutes,
  parseClock,
  wallClockToUtc,
} from './time';
import type {
  AvailabilityInput,
  AvailabilityResult,
  BookingRules,
  BusyBooking,
  ClockBlock,
  DateOverride,
  DateWindow,
  NoSlotReason,
  PartOfDay,
  SearchPlan,
  Slot,
  StaffMember,
} from './types';

export const DEFAULT_SLOT_MINUTES = 15;
export const DEFAULT_LIMIT = 3;
export const MAX_LIMIT = 5;
export const DEFAULT_MAX_SEARCH_DAYS = 60;

/** Statuses that keep a staff member busy (held only while the hold is live). */
export const BUSY_STATUSES = ['confirmed', 'held', 'checked_in', 'pending'] as const;

const NOON = 12 * 60;
const FIVE_PM = 17 * 60;

/** Higher = closer to bookable; the best reason across searched days wins. */
const REASON_RANK: Record<NoSlotReason, number> = {
  closed: 0,
  staff_off: 1,
  outside_lead_time: 2,
  fully_booked: 3,
};

type Interval = [number, number];

// ─── interval math (epoch ms, half-open) ───

function normalize(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const s = Math.max(a0, b0);
      const e = Math.min(a1, b1);
      if (e > s) out.push([s, e]);
    }
  }
  return normalize(out);
}

function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  let out = normalize(base);
  for (const [c0, c1] of cuts) {
    const next: Interval[] = [];
    for (const [s, e] of out) {
      if (c1 <= s || c0 >= e) {
        next.push([s, e]);
        continue;
      }
      if (c0 > s) next.push([s, c0]);
      if (c1 < e) next.push([c1, e]);
    }
    out = next;
  }
  return out;
}

// ─── wall-clock blocks → instants ───

/** [start, end) on `date`; an end at or before the start runs past midnight. */
function clockInterval(date: string, start: string, end: string, tz: string): Interval | null {
  const s = parseClock(start);
  let e = parseClock(end);
  if (s === null || e === null) return null;
  if (e <= s) e += DAY_MINUTES;
  return [wallClockToUtc(date, s, tz), wallClockToUtc(date, e, tz)];
}

function weeklyIntervals(blocks: ClockBlock[], date: string, tz: string): Interval[] {
  const dow = dayOfWeek(date);
  const out: Interval[] = [];
  for (const b of blocks) {
    if (b.dayOfWeek !== dow) continue;
    const iv = clockInterval(date, b.start, b.end, tz);
    if (iv) out.push(iv);
  }
  return normalize(out);
}

function isFullDayClosure(o: DateOverride): boolean {
  return !o.isAvailable && !o.start && !o.end;
}

function overrideIntervals(list: DateOverride[], tz: string): Interval[] {
  const out: Interval[] = [];
  for (const o of list) {
    if (o.start && o.end) {
      const iv = clockInterval(o.date, o.start, o.end, tz);
      if (iv) out.push(iv);
    } else {
      // An all-day open override covers the whole local day.
      out.push([wallClockToUtc(o.date, 0, tz), wallClockToUtc(addDays(o.date, 1), 0, tz)]);
    }
  }
  return normalize(out);
}

function partOfDayOf(minute: number): PartOfDay {
  if (minute < NOON) return 'morning';
  if (minute < FIVE_PM) return 'afternoon';
  return 'evening';
}

// ─── search plan ───

/**
 * Which dates a request looks at, shared by the action (to size the loader
 * queries) and the engine. With no date or window the search is "first
 * available" from today; nextOpenDate looks past the requested dates.
 */
export function searchPlan(opts: {
  today: string;
  date?: string;
  window?: DateWindow;
  rules: Pick<BookingRules, 'maxLeadDays'>;
  maxSearchDays?: number;
}): SearchPlan {
  const maxSearch = opts.maxSearchDays ?? DEFAULT_MAX_SEARCH_DAYS;
  const lastBookable = addDays(opts.today, opts.rules.maxLeadDays);
  let days: string[];
  if (opts.date) days = [opts.date];
  else if (opts.window) days = dateRange(opts.window.from, opts.window.to);
  else {
    const end = addDays(opts.today, maxSearch);
    days = dateRange(opts.today, end < lastBookable ? end : lastBookable);
  }
  const last = days[days.length - 1];
  const nextEnd = addDays(last, maxSearch);
  const nextOpenDays = opts.date || opts.window
    ? dateRange(addDays(last, 1), nextEnd < lastBookable ? nextEnd : lastBookable)
    : [];
  const final = nextOpenDays.length ? nextOpenDays[nextOpenDays.length - 1] : last;
  return { days, nextOpenDays, loadFrom: addDays(days[0], -1), loadTo: addDays(final, 1) };
}

// ─── engine ───

interface Candidate {
  ms: number;
  staff: StaffMember;
  dayLoad: number;
}

interface DayResult {
  candidates: Candidate[];
  reason: NoSlotReason | null;
}

/** Evenly spaced picks so the caller hears options across the day, not 3 adjacent times. */
export function spreadPick<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items.slice();
  if (limit <= 1) return items.slice(0, 1);
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    out.push(items[Math.round((i * (items.length - 1)) / (limit - 1))]);
  }
  return out;
}

/**
 * Bookable slots for the requested services. Pure: every input (hours,
 * schedules, overrides, bookings and holds, rules, clock) is passed in.
 */
export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const tz = input.timezone;
  const nowMs = input.now.getTime();
  const today = localDateOf(nowMs, tz);
  const gridMs = (input.slotMinutes ?? DEFAULT_SLOT_MINUTES) * MINUTE_MS;
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const rules = input.rules;

  const durationMs = input.services.reduce((sum, s) => sum + s.durationMin, 0) * MINUTE_MS;
  const bufferMs = input.services.reduce((max, s) => Math.max(max, s.bufferMin), 0) * MINUTE_MS;

  const serviceIds = input.services.map((s) => s.id);
  const wanted = input.staffId && input.staffId !== 'any' ? input.staffId : null;
  const eligible = input.staff.filter(
    (m) => (!wanted || m.id === wanted) && serviceIds.every((id) => m.serviceIds.includes(id)),
  );

  const plan = searchPlan({
    today,
    date: input.date,
    window: input.window,
    rules,
    maxSearchDays: input.maxSearchDays,
  });

  if (eligible.length === 0 || durationMs <= 0) {
    return { slots: [], reasonIfNone: 'staff_off' };
  }

  // Overrides by date, split into shop-wide and per staff member.
  const overridesByDate = new Map<string, DateOverride[]>();
  for (const o of input.overrides) {
    const list = overridesByDate.get(o.date) ?? [];
    list.push(o);
    overridesByDate.set(o.date, list);
  }
  const shopOverrides = (date: string) => (overridesByDate.get(date) ?? []).filter((o) => o.staffId === null);
  const staffOverrides = (date: string, id: string) => (overridesByDate.get(date) ?? []).filter((o) => o.staffId === id);
  const partialClosures = (list: DateOverride[]) =>
    overrideIntervals(list.filter((o) => !o.isAvailable && !isFullDayClosure(o)), tz);

  /** Shop windows for `date`; null when no business hours are configured. */
  const shopCache = new Map<string, Interval[] | null>();
  function shopWindows(date: string): Interval[] | null {
    const cached = shopCache.get(date);
    if (cached !== undefined) return cached;
    const own = shopOverrides(date);
    let result: Interval[] | null;
    if (own.some(isFullDayClosure)) result = [];
    else {
      const open = own.filter((o) => o.isAvailable);
      const base = open.length
        ? overrideIntervals(open, tz)
        : input.businessHours.length ? weeklyIntervals(input.businessHours, date, tz) : null;
      result = base === null ? null : subtract(base, partialClosures(own));
    }
    shopCache.set(date, result);
    return result;
  }

  /** Working windows that start on `date` for one staff member. */
  const staffCache = new Map<string, Interval[]>();
  function staffWindows(date: string, member: StaffMember): Interval[] {
    const key = `${date}\0${member.id}`;
    const hit = staffCache.get(key);
    if (hit) return hit;
    let result: Interval[];
    const shop = shopOverrides(date);
    const own = staffOverrides(date, member.id);
    if (shop.some(isFullDayClosure) || own.some(isFullDayClosure)) result = [];
    else {
      const open = own.filter((o) => o.isAvailable);
      let base: Interval[];
      if (open.length) {
        // Staff special hours replace both the weekly schedule and shop hours.
        base = overrideIntervals(open, tz);
      } else {
        const biz = shopWindows(date);
        const weekly = member.weekly.length ? weeklyIntervals(member.weekly, date, tz) : null;
        if (weekly && biz) base = intersect(weekly, biz);
        else base = weekly ?? biz ?? [];
      }
      result = subtract(subtract(base, partialClosures(shop)), partialClosures(own));
    }
    staffCache.set(key, result);
    return result;
  }

  // Bookings that keep each eligible staff member busy.
  const busyByStaff = new Map<string, BusyBooking[]>();
  for (const b of input.bookings) {
    if (!(BUSY_STATUSES as readonly string[]).includes(b.status)) continue;
    if (b.status === 'held' && !(b.holdExpiresAt && b.holdExpiresAt.getTime() > nowMs)) continue;
    const list = busyByStaff.get(b.staffId) ?? [];
    list.push(b);
    busyByStaff.set(b.staffId, list);
  }

  const lastBookable = addDays(today, rules.maxLeadDays);
  const earliestMs = nowMs + rules.minLeadMinutes * MINUTE_MS;
  const sameDayClosed = !rules.allowSameDay
    || (rules.sameDayCutoffMinute !== null && localMinuteOf(nowMs, tz) >= rules.sameDayCutoffMinute);

  function evaluateDay(date: string): DayResult {
    const dayStart = wallClockToUtc(date, 0, tz);
    const dayEnd = wallClockToUtc(addDays(date, 1), 0, tz);
    const daySpan: Interval[] = [[dayStart, dayEnd]];
    const prev = addDays(date, -1);
    const windowsOf = (m: StaffMember) => normalize([...staffWindows(prev, m), ...staffWindows(date, m)]);

    const eligibleWindows = eligible.map((m) => ({ member: m, windows: windowsOf(m) }));
    const working = eligibleWindows.filter((w) => intersect(w.windows, daySpan).length > 0);
    if (working.length === 0) {
      const shop = [shopWindows(prev), shopWindows(date)];
      const shopOpen = shop.every((s) => s === null)
        ? input.staff.some((m) => intersect(windowsOf(m), daySpan).length > 0)
        : intersect(normalize(shop.flatMap((s) => s ?? [])), daySpan).length > 0;
      return { candidates: [], reason: shopOpen ? 'staff_off' : 'closed' };
    }

    let raw = 0;
    let inLead = 0;
    const candidates: Candidate[] = [];
    for (const { member, windows } of working) {
      const busy = busyByStaff.get(member.id) ?? [];
      const dayLoad = busy.filter((b) => localDateOf(b.start.getTime(), tz) === date).length;
      const capped = rules.maxDailyBookings !== null && dayLoad >= rules.maxDailyBookings;
      for (const [a, b] of windows) {
        const off = offsetMinutes(a, tz) * MINUTE_MS;
        for (let t = Math.ceil((a + off) / gridMs) * gridMs - off; t + durationMs <= b; t += gridMs) {
          if (t < dayStart) continue;
          if (t >= dayEnd) break;
          if (input.at !== undefined && t !== input.at) continue;
          if (input.partOfDay && partOfDayOf(localMinuteOf(t, tz)) !== input.partOfDay) continue;
          raw += 1;
          if (t < nowMs || t < earliestMs || date > lastBookable || (date === today && sameDayClosed)) continue;
          inLead += 1;
          if (capped) continue;
          const blockedEnd = t + durationMs + bufferMs;
          if (busy.some((x) => x.start.getTime() < blockedEnd && x.blockedUntil.getTime() > t)) continue;
          candidates.push({ ms: t, staff: member, dayLoad });
        }
      }
    }

    if (candidates.length > 0) return { candidates, reason: null };
    if (raw === 0) return { candidates, reason: input.partOfDay ? 'closed' : 'fully_booked' };
    if (inLead === 0) return { candidates, reason: 'outside_lead_time' };
    return { candidates, reason: 'fully_booked' };
  }

  const order = new Map(eligible.map((m, i) => [m.id, i]));
  function toSlots(candidates: Candidate[]): Slot[] {
    // One staff member per start time: the least busy that day, then list order.
    const best = new Map<number, Candidate>();
    for (const c of candidates) {
      const cur = best.get(c.ms);
      if (!cur || c.dayLoad < cur.dayLoad || (c.dayLoad === cur.dayLoad && order.get(c.staff.id)! < order.get(cur.staff.id)!)) {
        best.set(c.ms, c);
      }
    }
    const unique = [...best.values()].sort((x, y) => x.ms - y.ms);
    const near = input.near;
    const picked = near === undefined
      ? spreadPick(unique, limit)
      : unique
        .slice()
        .sort((x, y) => Math.abs(x.ms - near) - Math.abs(y.ms - near) || x.ms - y.ms)
        .slice(0, limit)
        .sort((x, y) => x.ms - y.ms);
    return picked.map((c) => ({
      start: new Date(c.ms).toISOString(),
      end: new Date(c.ms + durationMs).toISOString(),
      staffId: c.staff.id,
      staffName: c.staff.name,
      spoken: spokenSlot(c.ms, nowMs, tz, input.locale),
    }));
  }

  let reason: NoSlotReason | null = null;
  for (const date of plan.days) {
    const day = evaluateDay(date);
    if (day.candidates.length > 0) return { slots: toSlots(day.candidates) };
    if (day.reason && (reason === null || REASON_RANK[day.reason] > REASON_RANK[reason])) reason = day.reason;
  }

  const result: AvailabilityResult = { slots: [], reasonIfNone: reason ?? 'closed' };
  // An exact-start check has no "next open date": the caller asks for alternatives separately.
  for (const date of input.at === undefined ? plan.nextOpenDays : []) {
    if (evaluateDay(date).candidates.length > 0) {
      result.nextOpenDate = date;
      break;
    }
  }
  return result;
}
