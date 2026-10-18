import { randomUUID } from 'node:crypto';
import type { NewActivity, NewOutboxEvent, SlaInstance, TicketRecord, TicketSettings, TicketsRepoFactory } from '../repo';
import { ACTIVE_STATUSES, type TicketPriority } from '../schemas';

/** A `ticket_sla_instances` row with the columns the update action keeps in sync. */
export type MemorySlaInstance = SlaInstance & {
  tenantId: string;
  responseMet: boolean | null;
  resolutionMet: boolean | null;
  pausedAt: Date | null;
  totalPausedMinutes: number;
};

export interface MemoryTicketsState {
  tickets: Array<TicketRecord & { tenantId: string }>;
  /** tickets.first_response_at by ticket id; absent means NULL. */
  firstResponseAt: Map<string, Date>;
  activities: Array<NewActivity & { tenantId: string }>;
  outbox: Array<NewOutboxEvent & { id: string; tenantId: string; status: 'pending' }>;
  settings: Map<string, TicketSettings>;
  /** First-response minutes per priority; each entry acts as policy `${tenantId}:${priority}` with the default 2880 resolution minutes. */
  slaMinutes: Map<string, Partial<Record<TicketPriority, number>>>;
  slaInstances: MemorySlaInstance[];
  members: Map<string, Set<string>>;
  locks: string[];
  /** `${tenantId}\0${callRef}` of calls that made a booking (bookings.intake_data.qvo.session). */
  bookedCalls: Set<string>;
  /** call_sessions.caller_number as stored, by `${tenantId}\0${callRef}`. */
  callerNumbers: Map<string, string>;
}

const EMPTY_SETTINGS: TicketSettings = {
  businessName: null,
  ownerName: null,
  slaText: null,
  callbackSlaMinutes: null,
  intakeSchemas: {},
};

/** In-memory TicketsRepo keyed by tenant, mirroring sqlTicketsRepo's semantics. */
export function createMemoryTicketsRepo(): { state: MemoryTicketsState; repo: TicketsRepoFactory } {
  const state: MemoryTicketsState = {
    tickets: [],
    firstResponseAt: new Map(),
    activities: [],
    outbox: [],
    settings: new Map(),
    slaMinutes: new Map(),
    slaInstances: [],
    members: new Map(),
    locks: [],
    bookedCalls: new Set(),
    callerNumbers: new Map(),
  };
  let nextNumber = 1000;

  const strip = ({ tenantId: _tenantId, ...ticket }: TicketRecord & { tenantId: string }): TicketRecord => ({
    ...ticket,
    intake: { ...ticket.intake },
  });

  const repo: TicketsRepoFactory = (_tx, tenantId) => {
    const own = () => state.tickets.filter((ticket) => ticket.tenantId === tenantId);
    const instancesOf = (ticketId: string) =>
      state.slaInstances.filter((row) => row.tenantId === tenantId && row.ticketId === ticketId);
    return {
      async getSettings() {
        return state.settings.get(tenantId) ?? EMPTY_SETTINGS;
      },
      async slaPolicy(priority) {
        const minutes = state.slaMinutes.get(tenantId)?.[priority];
        return minutes ? { id: `${tenantId}:${priority}`, firstResponseMinutes: minutes, resolutionMinutes: 2880 } : null;
      },
      async applySlaInstance(instance) {
        const current = instancesOf(instance.ticketId).pop();
        if (!current) {
          state.slaInstances.push({
            ...instance,
            tenantId,
            responseMet: null,
            resolutionMet: null,
            pausedAt: null,
            totalPausedMinutes: 0,
          });
          return;
        }
        if (instance.responseDueAt < current.responseDueAt) current.responseDueAt = instance.responseDueAt;
        if (instance.resolutionDueAt < current.resolutionDueAt) current.resolutionDueAt = instance.resolutionDueAt;
      },
      async recordFirstResponse(ticketId, wasUnassigned, now) {
        const ticket = own().find((row) => row.id === ticketId);
        const firstTime = Boolean(ticket) && !state.firstResponseAt.has(ticketId);
        if (firstTime) state.firstResponseAt.set(ticketId, now);
        if (!firstTime && !wasUnassigned) return;
        for (const row of instancesOf(ticketId)) {
          if (row.responseMet === null) row.responseMet = row.responseDueAt.getTime() >= now.getTime();
        }
      },
      async recordSlaResolved(ticketId, now) {
        for (const row of instancesOf(ticketId)) {
          if (row.resolutionMet === null) row.resolutionMet = row.resolutionDueAt.getTime() >= now.getTime();
        }
      },
      async pauseSla(ticketId, now) {
        for (const row of instancesOf(ticketId)) {
          if (row.pausedAt === null) row.pausedAt = now;
        }
      },
      async resumeSla(ticketId, now) {
        for (const row of instancesOf(ticketId)) {
          if (row.pausedAt === null) continue;
          const pausedMs = Math.max(0, now.getTime() - row.pausedAt.getTime());
          row.responseDueAt = new Date(row.responseDueAt.getTime() + pausedMs);
          row.resolutionDueAt = new Date(row.resolutionDueAt.getTime() + pausedMs);
          row.totalPausedMinutes += Math.floor(pausedMs / 60_000);
          row.pausedAt = null;
        }
      },
      async lockCallDedupe(key) {
        state.locks.push(`${tenantId}\0${key}`);
      },
      async findByCallRef(callRef, kind) {
        return own()
          .filter((ticket) => ticket.sourceCallRef === callRef && ticket.kind === kind)
          .map(strip);
      },
      async hasCallArtifact(callRef) {
        return (
          own().some((ticket) => ticket.sourceCallRef === callRef || ticket.callId === callRef) ||
          state.bookedCalls.has(`${tenantId}\0${callRef}`)
        );
      },
      async callerNumber(callRef) {
        return state.callerNumbers.get(`${tenantId}\0${callRef}`) ?? null;
      },
      async insert(input) {
        nextNumber += 1;
        const record: TicketRecord & { tenantId: string } = {
          tenantId,
          id: randomUUID(),
          ticketNumber: nextNumber,
          kind: input.kind,
          status: 'open',
          priority: input.priority,
          urgency: input.urgency,
          subject: input.subject,
          description: input.description,
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          assigneeId: null,
          callId: null,
          sourceCallRef: input.callRef,
          callbackDueAt: input.callbackDueAt,
          intake: { ...input.intake },
          createdAt: input.now,
          updatedAt: input.now,
        };
        state.tickets.push(record);
        return strip(record);
      },
      async addActivity(activity) {
        state.activities.push({ ...activity, tenantId });
      },
      async enqueueOutbox(event) {
        const id = randomUUID();
        state.outbox.push({ ...event, payload: { ...event.payload }, id, tenantId, status: 'pending' });
        return id;
      },
      async get(id) {
        const found = own().find((ticket) => ticket.id === id);
        return found ? strip(found) : null;
      },
      async update(id, patch, now) {
        const found = own().find((ticket) => ticket.id === id);
        if (!found) throw new Error(`ticket ${id} missing`);
        if (patch.status !== undefined) found.status = patch.status;
        if (patch.assigneeId !== undefined) found.assigneeId = patch.assigneeId;
        if (patch.priority !== undefined) found.priority = patch.priority;
        if (patch.urgency !== undefined) found.urgency = patch.urgency;
        if (patch.callbackDueAt !== undefined) found.callbackDueAt = patch.callbackDueAt;
        found.updatedAt = now;
        return strip(found);
      },
      async list(filter) {
        return own()
          .filter((ticket) => !filter.kind || ticket.kind === filter.kind)
          .filter((ticket) => filter.status === 'all' || ACTIVE_STATUSES.includes(ticket.status))
          .filter(
            (ticket) =>
              filter.status !== 'overdue' ||
              (ticket.callbackDueAt !== null && ticket.callbackDueAt.getTime() < filter.now.getTime()),
          )
          .slice(0, filter.limit)
          .map(strip);
      },
      async notes(ticketId, limit) {
        return state.activities
          .filter((activity) => activity.tenantId === tenantId && activity.ticketId === ticketId && activity.type === 'note')
          .slice(-limit)
          .map((activity) => ({ content: activity.content ?? '', createdAt: activity.now }));
      },
      async isTenantMember(userId) {
        return state.members.get(tenantId)?.has(userId) ?? false;
      },
    };
  };

  return { state, repo };
}
