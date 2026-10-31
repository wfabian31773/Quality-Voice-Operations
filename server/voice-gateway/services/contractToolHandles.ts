/**
 * Call-scoped handles for contract tool results (RT-14 prereq). The model
 * never sees an internal database id: a booking, staff member or service it
 * has to act on gets an opaque handle ("booking-1", "staff-2"), kept here for
 * the call and swapped back for the real id when the model sends it in.
 * Ids it never acts on (holds, tickets, the booking a move replaced) are
 * dropped, and so are refs like ticketNumber unless the contract's sayBack
 * lists them. The confirmation token stays: the two-phase protocol needs it.
 *
 * - Key-based: bookingId, staffId(s), serviceId(s), and `id` on a booking,
 *   staff or service list item, whatever their shape.
 * - Shape-based: any other uuid-shaped string, anywhere (a value, or inside a
 *   message), becomes a "ref-N" handle.
 * - An unknown handle the model sends is passed through as is, so it reaches
 *   the action's normal not-found path. One it guessed ("staff-2", never issued)
 *   is also retired: no real id ever gets that string later in the call, so a
 *   handle never changes meaning under the model, even with calls in flight.
 */

/** Ids the model never acts on: never shown. */
const DROPPED_KEYS: ReadonlySet<string> = new Set(['holdId', 'replacedHoldIds', 'ticketId', 'previousBookingId']);

/** Refs that are dropped unless the action's contract lists them in sayBack. */
export const REF_KEYS: ReadonlySet<string> = new Set(['ticketNumber']);

/** Passed through untouched: the two-phase protocol needs them back verbatim. */
const KEPT_KEYS: ReadonlySet<string> = new Set(['confirmationToken', 'payloadHash']);

const KIND_BY_KEY: Readonly<Record<string, string>> = {
  bookingId: 'booking',
  staffId: 'staff',
  staffIds: 'staff',
  serviceId: 'service',
  serviceIds: 'service',
};

/** Fields a later tool call takes back in: the confirmation token and the handle fields. */
export const NEXT_CALL_KEYS: ReadonlySet<string> = new Set(['confirmationToken', ...Object.keys(KIND_BY_KEY)]);

/** The kind of an `id` field, by the list it sits in. */
const KIND_BY_LIST: Readonly<Record<string, string>> = { bookings: 'booking', staff: 'staff', services: 'service' };

/** A read whose data is itself the list (scheduling.list_services returns an array). */
const KIND_BY_ACTION_LIST: Readonly<Record<string, string>> = {
  'scheduling.list_services': 'service',
  'scheduling.list_staff': 'staff',
};

/** Not an id: the "anyone" staff choice. */
const NOT_IDS: ReadonlySet<string> = new Set(['any']);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** What a handle of any kind looks like. */
const HANDLE_SHAPED = /^(?:booking|staff|service|ref)-\d+$/;

/** Whether a string contains a uuid. */
export function containsUuid(text: string): boolean {
  UUID.lastIndex = 0;
  const found = UUID.test(text);
  UUID.lastIndex = 0;
  return found;
}

export class CallHandles {
  private readonly handleByReal = new Map<string, string>();
  private readonly realByHandle = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  /** Handle-shaped strings the model sent before this call issued them: never issued now. */
  private readonly retired = new Set<string>();

  /** The handle for a real id (the same one every time in this call). */
  handleFor(real: string, kind: string): string {
    const known = this.handleByReal.get(real);
    if (known) return known;
    let n = this.counts.get(kind) ?? 0;
    let handle: string;
    do {
      n += 1;
      handle = `${kind}-${n}`;
    } while (this.retired.has(handle));
    this.counts.set(kind, n);
    this.handleByReal.set(real, handle);
    this.realByHandle.set(handle, real);
    return handle;
  }

  /** The real id behind a handle this call issued, or undefined. */
  realFor(handle: string): string | undefined {
    return this.realByHandle.get(handle);
  }

  /**
   * The model's view of an action result. `speakable` = the REF_KEYS the
   * action's contract may say back.
   */
  toModel(value: unknown, action: string, speakable: ReadonlySet<string> = new Set()): unknown {
    return this.out(value, undefined, undefined, { action, speakable });
  }

  /**
   * The action's view of the model's arguments: every handle this call issued
   * is swapped for its real id, and a handle-shaped string it didn't issue is
   * left as is and retired.
   */
  fromModel(args: Record<string, unknown>): Record<string, unknown> {
    return this.in(args) as Record<string, unknown>;
  }

  /** The handle-shaped values in the arguments' id fields that this call never issued: the model's guesses. */
  unissuedIds(args: Record<string, unknown>): string[] {
    return [...new Set(this.guesses(args, undefined))];
  }

  private guesses(value: unknown, key: string | undefined): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => this.guesses(item, key));
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => this.guesses(v, k));
    }
    const isId = typeof value === 'string' && key !== undefined && KIND_BY_KEY[key] !== undefined;
    return isId && HANDLE_SHAPED.test(value) && !this.realByHandle.has(value) ? [value] : [];
  }

  private out(value: unknown, key: string | undefined, list: string | undefined, opts: { action: string; speakable: ReadonlySet<string> }): unknown {
    if (Array.isArray(value)) return value.map((item) => this.out(item, key, key, opts));
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (DROPPED_KEYS.has(k)) continue;
        if (REF_KEYS.has(k) && !opts.speakable.has(k)) continue;
        result[k] = KEPT_KEYS.has(k) ? v : this.out(v, k, list, opts);
      }
      return result;
    }
    if (typeof value !== 'string') return value;
    const kind = key === 'id'
      ? (list === 'data' ? KIND_BY_ACTION_LIST[opts.action] : list ? KIND_BY_LIST[list] : undefined)
      : key ? KIND_BY_KEY[key] : undefined;
    if (kind && value.trim() && !NOT_IDS.has(value)) return this.handleFor(value, kind);
    return value.replace(UUID, (id) => this.handleByReal.get(id) ?? this.handleFor(id, 'ref'));
  }

  private in(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.in(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.in(v)]));
    }
    if (typeof value !== 'string') return value;
    const real = this.realByHandle.get(value);
    if (real) return real;
    if (HANDLE_SHAPED.test(value)) this.retired.add(value);
    return value;
  }
}
