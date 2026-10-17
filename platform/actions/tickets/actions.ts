import type { z } from 'zod';
import {
  actionFail,
  actionOk,
  consumeProposal,
  createProposal,
  defineAction,
  isActionFailure,
  type ActionContext,
  type AnyActionDefinition,
} from '../core';
import { validateIntake } from './intake';
import { intakeSchemaFor } from './intakeSchemas';
import { buildOpenReadback, normalizePhone } from './readback';
import { sqlTicketsRepo, type NewActivity, type TicketPatch, type TicketRecord, type TicketsRepo, type TicketsRepoFactory } from './repo';
import {
  ACTIVE_STATUSES,
  addNoteInput,
  addNoteOutput,
  canTransition,
  getInput,
  listInput,
  listOutput,
  openCommitInput,
  openCommitOutput,
  openPrepareInput,
  openPrepareOutput,
  ticketDetail,
  ticketSummary,
  updateInput,
  type OpenPrepareInput,
  type TicketPriority,
  type TicketSummary,
  type TicketUrgency,
} from './schemas';

export const OPEN_PREPARE = 'tickets.open.prepare';
export const OPEN_COMMIT = 'tickets.open.commit';

/** Same roles as requireMiniSystemWrite on the ticket routes. */
const WRITE_ROLES = ['tenant_owner', 'operations_manager'];
const NOTES_LIMIT = 50;

export interface TicketsActionDeps {
  repo?: TicketsRepoFactory;
}

function actorUserId(ctx: ActionContext): string | null {
  return ctx.actor.type === 'user' ? ctx.actor.id : null;
}

function sourceFor(ctx: ActionContext): 'manual' | 'api' | 'ai_agent' {
  if (ctx.actor.type === 'agent') return 'ai_agent';
  if (ctx.actor.type === 'user') return 'manual';
  return 'api';
}

function priorityFor(urgency: TicketUrgency): TicketPriority {
  return urgency === 'urgent' ? 'urgent' : 'medium';
}

function isOverdue(ticket: TicketRecord, now: Date): boolean {
  return (
    ticket.callbackDueAt !== null &&
    ticket.callbackDueAt.getTime() < now.getTime() &&
    ACTIVE_STATUSES.includes(ticket.status)
  );
}

function toSummary(ticket: TicketRecord, now: Date): TicketSummary {
  return {
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    kind: ticket.kind,
    status: ticket.status,
    priority: ticket.priority,
    urgency: ticket.urgency,
    subject: ticket.subject,
    contactName: ticket.contactName,
    contactPhone: ticket.contactPhone,
    assigneeId: ticket.assigneeId,
    callbackDueAt: ticket.callbackDueAt?.toISOString() ?? null,
    overdue: isOverdue(ticket, now),
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

function addMinutes(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * callback_due_at comes only from tenant config: settings first, then an active SLA policy. Never invented.
 * When a policy supplies it, the matching SLA instance uses the same clock, so response_due_at equals it.
 */
async function resolveSla(repo: TicketsRepo, minutesFromSettings: number | null, priority: TicketPriority, now: Date) {
  if (minutesFromSettings) return { dueAt: addMinutes(now, minutesFromSettings), instance: null };
  const policy = await repo.slaPolicy(priority);
  if (!policy) return { dueAt: null, instance: null };
  const dueAt = addMinutes(now, policy.firstResponseMinutes);
  return {
    dueAt,
    instance: { policyId: policy.id, responseDueAt: dueAt, resolutionDueAt: addMinutes(now, policy.resolutionMinutes) },
  };
}

function ticketDescription(details: string, callbackWindow: string | undefined): string {
  const window = callbackWindow ? `Best time to call back: ${callbackWindow}` : '';
  return [details, window].filter(Boolean).join('\n\n');
}

type OpenPayload = OpenPrepareInput & { details: string; urgency: TicketUrgency; intake: Record<string, unknown> };

function withOpenDefaults(input: OpenPrepareInput): OpenPayload {
  return { ...input, details: input.details ?? '', urgency: input.urgency ?? 'normal', intake: input.intake ?? {} };
}

export function createTicketsActions(deps: TicketsActionDeps = {}): AnyActionDefinition[] {
  const repoFor = deps.repo ?? sqlTicketsRepo;

  const openPrepare = defineAction({
    name: OPEN_PREPARE,
    tool: 'tickets',
    kind: 'prepare',
    input: openPrepareInput,
    output: openPrepareOutput,
    permissions: { roles: WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
    agentDescription:
      'Prepare a message, callback request, complaint, quote request or intake for the business. ' +
      'Read the returned readback to the caller word for word and commit only after an explicit yes.',
    async run(ctx, input, tx) {
      const settings = await repoFor(tx, ctx.tenantId).getSettings();
      const intake = validateIntake(input.intake, intakeSchemaFor(input.kind, settings.intakeSchemas));
      if (!intake.ok) {
        return actionFail('VALIDATION_FAILED', intake.message, { field: intake.field });
      }
      const payload = withOpenDefaults({ ...input, intake: intake.value });
      const readback = buildOpenReadback(payload, settings);
      const proposal = await createProposal(tx, ctx, { action: OPEN_PREPARE, payload, readback, callId: ctx.callId });
      return actionOk(
        {
          confirmationToken: proposal.confirmationToken,
          expiresAt: proposal.expiresAt.toISOString(),
          readback: proposal.readback,
          payloadHash: proposal.payloadHash,
        },
        { readback: proposal.readback },
      );
    },
  });

  const openCommit = defineAction({
    name: OPEN_COMMIT,
    tool: 'tickets',
    kind: 'commit',
    input: openCommitInput,
    output: openCommitOutput,
    permissions: { roles: WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
    agentDescription:
      'Commit a prepared ticket after the caller explicitly said yes to the readback. ' +
      'A repeat of the same request in this call is added to the first ticket.',
    async run(ctx, input, tx) {
      const consumed = await consumeProposal(tx, ctx, {
        confirmationToken: input.confirmationToken,
        action: OPEN_PREPARE,
        payloadHash: input.payloadHash,
        callId: ctx.callId,
      });
      if (isActionFailure(consumed)) return consumed;
      const parsed = openPrepareInput.safeParse(consumed.payload);
      if (!parsed.success) return actionFail('CONFIRMATION_INVALID', 'Stored proposal payload is not a ticket');
      const payload = withOpenDefaults(parsed.data);
      const repo = repoFor(tx, ctx.tenantId);
      const userId = actorUserId(ctx);
      const phoneKey = normalizePhone(payload.customer.phone);
      const callRef = ctx.callId ?? null;

      if (callRef) {
        await repo.lockCallDedupe(`${callRef}\0${payload.kind}\0${phoneKey}`);
        const candidates = await repo.findByCallRef(callRef, payload.kind);
        const first = candidates.find((ticket) => normalizePhone(ticket.contactPhone) === phoneKey);
        if (first) {
          const note = [`Repeated during the same call: ${payload.subject}`, payload.details].filter(Boolean).join('\n\n');
          await repo.addActivity({
            ticketId: first.id,
            actorUserId: userId,
            type: 'note',
            content: ticketDescription(note, payload.callbackWindow),
            metadata: { dedupe: true, urgency: payload.urgency },
            now: ctx.now,
          });
          const patch: TicketPatch = {};
          if (payload.urgency === 'urgent' && first.urgency !== 'urgent') {
            patch.urgency = 'urgent';
            if (first.priority !== 'urgent') {
              patch.priority = 'urgent';
              await repo.addActivity({
                ticketId: first.id,
                actorUserId: userId,
                type: 'priority_change',
                fieldName: 'priority',
                oldValue: first.priority,
                newValue: 'urgent',
                now: ctx.now,
              });
            }
            // Same rules as a new urgent ticket, but the deadline only ever moves earlier.
            const settings = await repo.getSettings();
            const sla = await resolveSla(repo, settings.callbackSlaMinutes, 'urgent', ctx.now);
            if (sla.dueAt && (!first.callbackDueAt || sla.dueAt < first.callbackDueAt)) {
              patch.callbackDueAt = sla.dueAt;
              await repo.addActivity({
                ticketId: first.id,
                actorUserId: userId,
                type: 'field_change',
                fieldName: 'callback_due_at',
                oldValue: first.callbackDueAt?.toISOString() ?? '',
                newValue: sla.dueAt.toISOString(),
                now: ctx.now,
              });
            }
            if (sla.instance) await repo.applySlaInstance({ ...sla.instance, ticketId: first.id });
          }
          const updated = await repo.update(first.id, patch, ctx.now);
          return actionOk({
            ticketId: updated.id,
            ticketNumber: updated.ticketNumber,
            dueAt: updated.callbackDueAt?.toISOString() ?? null,
            deduped: true,
          });
        }
      }

      const settings = await repo.getSettings();
      const priority = priorityFor(payload.urgency);
      const { dueAt, instance } = await resolveSla(repo, settings.callbackSlaMinutes, priority, ctx.now);
      const ticket = await repo.insert({
        kind: payload.kind,
        subject: payload.subject,
        description: ticketDescription(payload.details, payload.callbackWindow),
        contactName: payload.customer.name ?? '',
        contactPhone: payload.customer.phone,
        urgency: payload.urgency,
        priority,
        source: sourceFor(ctx),
        intake: payload.intake,
        callbackDueAt: dueAt,
        callRef,
        createdByUserId: userId,
        now: ctx.now,
      });
      // Like the admin create route: the breach worker and SLA queues read only ticket_sla_instances.
      if (instance) await repo.applySlaInstance({ ...instance, ticketId: ticket.id });
      await repo.addActivity({
        ticketId: ticket.id,
        actorUserId: userId,
        type: 'created',
        content: `Opened through ${OPEN_COMMIT}`,
        metadata: {
          kind: payload.kind,
          urgency: payload.urgency,
          actor: ctx.actor.type,
          ...(payload.related ? { related: payload.related } : {}),
          ...(payload.callbackWindow ? { callbackWindow: payload.callbackWindow } : {}),
        },
        now: ctx.now,
      });
      const data = {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        dueAt: ticket.callbackDueAt?.toISOString() ?? null,
        deduped: false,
      };
      // The owner alert's source of truth is this ticket_outbox row, written in
      // the same transaction as the ticket (rolls back with it). A commit retry
      // with the same token replays the stored result in runAction without
      // calling run(), so no second row; the unique index from migration 123
      // backs that up. `effects` below is informational only and is replayed
      // verbatim on retries: adapters must not dispatch from it.
      const event = {
        ...data,
        kind: ticket.kind,
        urgency: ticket.urgency,
        priority: ticket.priority,
        callId: callRef,
        proposalId: input.confirmationToken,
        idempotencyKey: ctx.idempotencyKey ?? input.confirmationToken,
      };
      const outboxId = await repo.enqueueOutbox({ eventType: 'ticket.opened', payload: event });
      return actionOk(data, { effects: [{ type: 'ticket.opened', payload: { ...event, outboxId } }] });
    },
  });

  const addNote = defineAction({
    name: 'tickets.add_note',
    tool: 'tickets',
    kind: 'write',
    input: addNoteInput,
    output: addNoteOutput,
    permissions: { roles: WRITE_ROLES, mcpScope: 'qvo:admin' },
    async run(ctx, input, tx) {
      const repo = repoFor(tx, ctx.tenantId);
      const ticket = await repo.get(input.ticketId, { forUpdate: true });
      if (!ticket) return actionFail('NOT_FOUND', 'Ticket not found', { field: 'ticketId' });
      await repo.addActivity({
        ticketId: ticket.id,
        actorUserId: actorUserId(ctx),
        type: 'note',
        content: input.note,
        now: ctx.now,
      });
      await repo.update(ticket.id, {}, ctx.now);
      return actionOk({ ticketId: ticket.id, noted: true as const });
    },
  });

  const update = defineAction({
    name: 'tickets.update',
    tool: 'tickets',
    kind: 'write',
    input: updateInput,
    output: ticketSummary,
    permissions: { roles: WRITE_ROLES, mcpScope: 'qvo:admin' },
    async run(ctx, input, tx) {
      const repo = repoFor(tx, ctx.tenantId);
      const ticket = await repo.get(input.ticketId, { forUpdate: true });
      if (!ticket) return actionFail('NOT_FOUND', 'Ticket not found', { field: 'ticketId' });

      if (input.status !== undefined && !canTransition(ticket.status, input.status)) {
        return actionFail('VALIDATION_FAILED', `Cannot move a ${ticket.status} ticket to ${input.status}`, {
          field: 'status',
          callerSafeMessage: "That status change isn't allowed.",
        });
      }
      if (input.assigneeId && !(await repo.isTenantMember(input.assigneeId))) {
        return actionFail('VALIDATION_FAILED', 'Assignee is not a member of this tenant', { field: 'assigneeId' });
      }

      const userId = actorUserId(ctx);
      const patch: TicketPatch = {};
      const activities: Omit<NewActivity, 'ticketId' | 'actorUserId' | 'now'>[] = [];
      if (input.status !== undefined && input.status !== ticket.status) {
        patch.status = input.status;
        activities.push({ type: 'status_change', fieldName: 'status', oldValue: ticket.status, newValue: input.status });
      }
      if (input.priority !== undefined && input.priority !== ticket.priority) {
        patch.priority = input.priority;
        activities.push({ type: 'priority_change', fieldName: 'priority', oldValue: ticket.priority, newValue: input.priority });
      }
      if (input.assigneeId !== undefined && input.assigneeId !== ticket.assigneeId) {
        patch.assigneeId = input.assigneeId;
        activities.push({
          type: input.assigneeId ? 'assigned' : 'unassigned',
          oldValue: ticket.assigneeId ?? '',
          newValue: input.assigneeId ?? '',
        });
      }
      if (input.dueAt !== undefined) {
        const dueAt = input.dueAt === null ? null : new Date(input.dueAt);
        if ((dueAt?.getTime() ?? null) !== (ticket.callbackDueAt?.getTime() ?? null)) {
          patch.callbackDueAt = dueAt;
          activities.push({
            type: 'field_change',
            fieldName: 'callback_due_at',
            oldValue: ticket.callbackDueAt?.toISOString() ?? '',
            newValue: dueAt?.toISOString() ?? '',
          });
        }
      }
      if (activities.length === 0) return actionOk(toSummary(ticket, ctx.now));

      for (const activity of activities) {
        await repo.addActivity({ ...activity, ticketId: ticket.id, actorUserId: userId, now: ctx.now });
      }
      const updated = await repo.update(ticket.id, patch, ctx.now);
      return actionOk(toSummary(updated, ctx.now));
    },
  });

  const list = defineAction({
    name: 'tickets.list',
    tool: 'tickets',
    kind: 'read',
    input: listInput,
    output: listOutput,
    permissions: { mcpScope: 'qvo:read' },
    async run(ctx, input, tx) {
      const tickets = await repoFor(tx, ctx.tenantId).list({
        status: input.status ?? 'open',
        kind: input.kind,
        limit: input.limit ?? 50,
        now: ctx.now,
      });
      return actionOk({ tickets: tickets.map((ticket) => toSummary(ticket, ctx.now)) });
    },
  });

  const get = defineAction({
    name: 'tickets.get',
    tool: 'tickets',
    kind: 'read',
    input: getInput,
    output: ticketDetail,
    permissions: { mcpScope: 'qvo:read' },
    async run(ctx, input, tx) {
      const repo = repoFor(tx, ctx.tenantId);
      const ticket = await repo.get(input.ticketId);
      if (!ticket) return actionFail('NOT_FOUND', 'Ticket not found', { field: 'ticketId' });
      const notes = await repo.notes(ticket.id, NOTES_LIMIT);
      const detail: z.infer<typeof ticketDetail> = {
        ...toSummary(ticket, ctx.now),
        details: ticket.description,
        intake: ticket.intake,
        callId: ticket.callId,
        sourceCallRef: ticket.sourceCallRef,
        notes: notes.map((note) => ({ content: note.content, createdAt: note.createdAt.toISOString() })),
      };
      return actionOk(detail);
    },
  });

  return [openPrepare, openCommit, addNote, update, list, get];
}
