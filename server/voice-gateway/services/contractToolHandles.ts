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
 *   the action's normal not-found path.
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

  /** The handle for a real id (the same one every time in this call). */
  handleFor(real: string, kind: string): string {
    const known = this.handleByReal.get(real);
    if (known) return known;
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const handle = `${kind}-${n}`;
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

  /** The action's view of the model's arguments: every handle this call issued is swapped for its real id. */
  fromModel(args: Record<string, unknown>): Record<string, unknown> {
    return this.in(args) as Record<string, unknown>;
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
    return typeof value === 'string' ? this.realByHandle.get(value) ?? value : value;
  }
}
