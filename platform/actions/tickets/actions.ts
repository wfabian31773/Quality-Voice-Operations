import type { z, ZodError } from 'zod';
import {
  isEmptySlotValue,
  TICKETS_MESSAGE_V1,
  valueAtPath,
  type HeldFacts,
  type SlotSpec,
} from '../../callcore/contracts';
import {
  actionFail,
  actionOk,
  consumeProposal,
  createProposal,
  defineAction,
  isActionFailure,
  type ActionContext,
  type ActionResult,
  type AnyActionDefinition,
} from '../core';
import { readbackLang, toE164 } from '../scheduling/readback';
import { clearSlotAsks, countSlotAsk } from '../scheduling/slotAsks';
import { createFloorAction, type CallerNumberDecrypter } from './floor';
import { validateIntake } from './intake';
import { intakeSchemaFor } from './intakeSchemas';
import { buildOpenReadback, normalizePhone } from './readback';
import { sqlTicketsRepo, type NewActivity, type TicketPatch, type TicketRecord, type TicketsRepoFactory } from './repo';
import { priorityFor, resolveSla } from './sla';
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
  openPrepareActionInput,
  openPrepareInput,
  openPrepareOutput,
  ticketDetail,
  ticketSummary,
  updateInput,
  type OpenPrepareActionInput,
  type OpenTicketInput,
  type TicketKind,
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
  /** Decrypts call_sessions.caller_number for the floor ticket; tests inject a fake. */
  decryptCallerNumber?: CallerNumberDecrypter;
}

function actorUserId(ctx: ActionContext): string | null {
  return ctx.actor.type === 'user' ? ctx.actor.id : null;
}

function sourceFor(ctx: ActionContext): 'manual' | 'api' | 'ai_agent' {
  if (ctx.actor.type === 'agent') return 'ai_agent';
  if (ctx.actor.type === 'user') return 'manual';
  return 'api';
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

/** Marks a message the caller left without a callback number, so the shop sees it. */
export const NO_CALLBACK_NUMBER = 'No callback number given.';

function ticketDescription(details: string, callbackWindow: string | undefined, phone?: string): string {
  const window = callbackWindow ? `Best time to call back: ${callbackWindow}` : '';
  return [phone ? '' : NO_CALLBACK_NUMBER, details, window].filter(Boolean).join('\n\n');
}

type OpenPayload = OpenTicketInput & { details: string; urgency: TicketUrgency; intake: Record<string, unknown> };

function withOpenDefaults(input: OpenTicketInput): OpenPayload {
  return { ...input, details: input.details ?? '', urgency: input.urgency ?? 'normal', intake: input.intake ?? {} };
}

/** Same shape as runAction's input validation failure: the first issue's message and path. */
function validationFailure(error: ZodError): ActionResult<never> {
  const issue = error.issues[0];
  const field = issue?.path?.length ? issue.path.map(String).join('.') : undefined;
  return actionFail('VALIDATION_FAILED', issue?.message ?? 'Invalid input', { field });
}

/** Ticket kinds the agent files under tickets.message@1. */
const MESSAGE_KINDS: ReadonlySet<TicketKind> = new Set<TicketKind>(['message', 'callback']);

/** What the agent says when the subject is still missing after one ask: no second ask. */
const MESSAGE_EXIT = {
  en: "I'll let the team know you called.",
  es: 'Le avisaré al equipo que llamó.',
};

/**
 * tickets.message@1 at the action: each required slot the input leaves empty
 * and no held fact fills is asked once (counted server-side per tenant, call,
 * contract and slot in slotAsks.ts, never from model args). The second miss
 * of the subject exits; the callback number instead proceeds (afterAsk), so
 * the message is prepared without one. A filled slot's count is cleared; a
 * declined callback number stays counted, so a correction or a second
 * message in the call doesn't ask for it again.
 */
function enforceMessageContract(ctx: ActionContext, input: OpenPrepareActionInput): OpenTicketInput | ActionResult<never> {
  const contract = TICKETS_MESSAGE_V1;
  const lang = readbackLang(ctx.locale);
  const callerPhone = ctx.callerPhone ? toE164(ctx.callerPhone) : null;
  const held: HeldFacts = callerPhone ? { callerPhone } : {};
  // With no call or conversation, asks can't be counted: a slot that proceeds never blocks.
  const counted = Boolean(ctx.callId ?? ctx.conversationId);
  const filled: SlotSpec[] = [];
  for (const slot of contract.slots) {
    if (!slot.required) continue;
    const given = !isEmptySlotValue(valueAtPath(input, slot.inputPath));
    if (given || (slot.heldFrom && !isEmptySlotValue(held[slot.heldFrom]))) {
      filled.push(slot);
      continue;
    }
    if (slot.afterAsk === 'proceed' && !counted) continue;
    const asks = countSlotAsk(ctx, contract, slot);
    if (asks <= contract.ceilings.maxAsksPerSlot) {
      return actionFail('SLOT_MISSING', `Missing ${slot.name}: ask ${slot.askId}, then call prepare again`, {
        field: slot.name,
        askId: slot.askId,
        retryable: true,
        callerSafeMessage: slot.defaultAsk[lang],
      });
    }
    if (slot.afterAsk === 'proceed') continue;
    return actionFail('SLOT_MISSING', `Still missing ${slot.name} after one ask this call; do not ask again`, {
      field: slot.name,
      askId: slot.askId,
      exit: 'message_ticket',
      retryable: false,
      callerSafeMessage: MESSAGE_EXIT[lang],
    });
  }
  clearSlotAsks(ctx, { ...contract, slots: filled });
  const subject = input.subject?.trim();
  if (!subject) return actionFail('VALIDATION_FAILED', 'Message details are incomplete', { field: 'subject' });
  const phone = input.customer?.phone?.trim() || callerPhone || undefined;
  return { ...input, subject, customer: { name: input.customer?.name, phone } };
}

/**
 * The agent's messages and callbacks follow tickets.message@1; staff, UI and
 * MCP callers and every other kind get exactly the openPrepareInput validation.
 */
function openTicketInput(ctx: ActionContext, input: OpenPrepareActionInput): OpenTicketInput | ActionResult<never> {
  if (ctx.actor.type === 'agent' && MESSAGE_KINDS.has(input.kind)) return enforceMessageContract(ctx, input);
  const strict = openPrepareInput.safeParse(input);
  return strict.success ? strict.data : validationFailure(strict.error);
}

export function createTicketsActions(deps: TicketsActionDeps = {}): AnyActionDefinition[] {
  const repoFor = deps.repo ?? sqlTicketsRepo;

  const openPrepare = defineAction({
    name: OPEN_PREPARE,
    tool: 'tickets',
    kind: 'prepare',
    input: openPrepareActionInput,
    output: openPrepareOutput,
    permissions: { roles: WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
    agentDescription:
      'Prepare a message, callback request, complaint, quote request or intake for the business. ' +
      'Read the returned readback to the caller word for word and commit only after an explicit yes. ' +
      'For a message or callback, the callback number comes from caller ID when there is one; do not ask for it. ' +
      'On SLOT_MISSING, ask the caller the one question in callerSafeMessage and call prepare again; if the caller ' +
      'will not give a callback number, call prepare again without one and the message is filed without it. ' +
      'If exit is set, do not ask again: say callerSafeMessage.',
    async run(ctx, rawInput, tx) {
      const input = openTicketInput(ctx, rawInput);
      if (isActionFailure(input)) return input;
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
      // Prepare already enforced its rules; only a tickets.message@1 message may lack a callback number.
      const parsed = openPrepareActionInput.safeParse(consumed.payload);
      const stored = parsed.success ? parsed.data : null;
      const subject = stored?.subject;
      if (!stored || !subject) return actionFail('CONFIRMATION_INVALID', 'Stored proposal payload is not a ticket');
      const phone = stored.customer?.phone || undefined;
      const payload = withOpenDefaults({ ...stored, subject, customer: { name: stored.customer?.name, phone } });
      const repo = repoFor(tx, ctx.tenantId);
      const userId = actorUserId(ctx);
      const phoneKey = normalizePhone(phone ?? '');
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
            content: ticketDescription(note, payload.callbackWindow, phone),
            metadata: { dedupe: true, urgency: payload.urgency, ...(phone ? {} : { noCallbackNumber: true }) },
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
        description: ticketDescription(payload.details, payload.callbackWindow, phone),
        contactName: payload.customer.name ?? '',
        // contact_phone is nullable with a '' default; '' is how the floor stores "no number" too.
        contactPhone: phone ?? '',
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
          ...(phone ? {} : { noCallbackNumber: true }),
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
      // Keep ticket_sla_instances in step like the admin PATCH. Un-pausing runs first so a
      // ticket resolved or assigned straight out of pending is judged on its shifted due times.
      if (patch.status !== undefined && ticket.status === 'pending') await repo.resumeSla(ticket.id, ctx.now);
      if (patch.assigneeId) await repo.recordFirstResponse(ticket.id, ticket.assigneeId === null, ctx.now);
      if (patch.status === 'resolved') await repo.recordSlaResolved(ticket.id, ctx.now);
      if (patch.status === 'pending') await repo.pauseSla(ticket.id, ctx.now);
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

  const fileFloor = createFloorAction({ repo: repoFor, decryptCallerNumber: deps.decryptCallerNumber });

  return [openPrepare, openCommit, addNote, update, list, get, fileFloor];
}
