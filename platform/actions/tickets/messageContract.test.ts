// RT-07: tickets.message@1 enforced inside tickets.open.prepare for the
// agent's messages and callbacks. A missing callback number is asked once,
// then the message is filed anyway; staff/UI callers and the other kinds
// validate exactly as before.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TICKETS_MESSAGE_V1 } from '../../callcore/contracts';
import { createMemoryStore, runAction, type ActionContext, type ActionResult } from '../core';
import { createMemoryTicketsRepo } from './__fixtures__/memoryRepo';
import { createTicketsActions, NO_CALLBACK_NUMBER, OPEN_COMMIT, OPEN_PREPARE } from './actions';
import { openPrepareInput } from './schemas';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const TENANT = 'tenant-a';

type Prepared = { confirmationToken: string; payloadHash: string; readback: string };
type Committed = { ticketId: string; deduped: boolean };

// The ask counter is per call, so every test gets its own call id.
function agentCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: TENANT,
    actor: { type: 'agent', id: 'agent-1' },
    now: NOW,
    tenantTimezone: 'America/New_York',
    callId: `call-${randomUUID()}`,
    ...overrides,
  };
}

function ownerCtx(): ActionContext {
  return agentCtx({ actor: { type: 'user', id: 'owner-1', role: 'tenant_owner' }, callId: undefined });
}

function setup() {
  const store = createMemoryStore();
  const tickets = createMemoryTicketsRepo();
  const deps = { store, registry: createTicketsActions({ repo: tickets.repo }), withTenantTx: store.withTenantTx.bind(store) };
  // Each prepare is a fresh model tool call, so it gets its own idempotency key.
  const prepare = (ctx: ActionContext, input: unknown) => runAction(OPEN_PREPARE, { ...ctx, idempotencyKey: randomUUID() }, input, deps);
  const commit = (ctx: ActionContext, prepared: Prepared) =>
    runAction(OPEN_COMMIT, ctx, { confirmationToken: prepared.confirmationToken, payloadHash: prepared.payloadHash }, deps);
  return { tickets, prepare, commit };
}

function data<T>(result: ActionResult): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data as T;
}

function failure(result: ActionResult) {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

const message = (overrides: Record<string, unknown> = {}) => ({ kind: 'message', subject: 'the order for Friday', ...overrides });

describe('tickets.message@1 in tickets.open.prepare: callback number', () => {
  it('caller ID present: no ask; the ticket is prepared and committed with that number', async () => {
    const { tickets, prepare, commit } = setup();
    const ctx = agentCtx({ callerPhone: '+15550100142' });
    const prepared = data<Prepared>(await prepare(ctx, message({ customer: { name: 'Luis' } })));
    expect(prepared.readback).toBe("I'll pass this to the team: a message about the order for Friday, callback at 555, 010, 0142.");
    expect(data<Committed>(await commit(ctx, prepared)).deduped).toBe(false);
    expect(tickets.state.tickets.map((t) => [t.contactName, t.contactPhone])).toEqual([['Luis', '+15550100142']]);
    expect(tickets.state.tickets[0].description).not.toContain(NO_CALLBACK_NUMBER);
  });

  it('no caller ID, no number: asks once, then files anyway with no number, marked for the shop', async () => {
    const { tickets, prepare, commit } = setup();
    const ctx = agentCtx();

    const first = failure(await prepare(ctx, message()));
    expect(first).toMatchObject({
      code: 'SLOT_MISSING',
      field: 'callbackNumber',
      askId: 'ask.callbackNumber',
      retryable: true,
      callerSafeMessage: 'What number should they call you back on?',
    });
    expect(first.exit).toBeUndefined();

    const prepared = data<Prepared>(await prepare(ctx, message({ customer: { phone: '' } })));
    expect(prepared.readback).toBe("I'll pass this to the team: a message about the order for Friday, with no callback number left.");
    expect(data<Committed>(await commit(ctx, prepared)).deduped).toBe(false);

    expect(tickets.state.tickets).toHaveLength(1);
    const [ticket] = tickets.state.tickets;
    expect(ticket).toMatchObject({ kind: 'message', contactPhone: '', subject: 'the order for Friday' });
    expect(ticket.description.split('\n\n')[0]).toBe(NO_CALLBACK_NUMBER);
    const created = tickets.state.activities.find((a) => a.ticketId === ticket.id && a.type === 'created');
    expect(created?.metadata).toMatchObject({ kind: 'message', noCallbackNumber: true });
    expect(tickets.state.outbox.map((row) => row.eventType)).toEqual(['ticket.opened']);
  });

  it('a second no-number message in the call is not asked again and becomes a note on the first', async () => {
    const { tickets, prepare, commit } = setup();
    const ctx = agentCtx();
    failure(await prepare(ctx, message()));
    data<Committed>(await commit(ctx, data<Prepared>(await prepare(ctx, message()))));

    const again = data<Prepared>(await prepare(ctx, message({ subject: 'the order, again' })));
    expect(data<Committed>(await commit(ctx, again)).deduped).toBe(true);
    expect(tickets.state.tickets).toHaveLength(1);
    const note = tickets.state.activities.find((a) => a.type === 'note');
    expect(note?.metadata).toMatchObject({ dedupe: true, noCallbackNumber: true });
    expect(tickets.state.outbox).toHaveLength(1);
  });

  it('no caller ID, number given on the retry: the ticket has that number', async () => {
    const { tickets, prepare, commit } = setup();
    const ctx = agentCtx();
    expect(failure(await prepare(ctx, message({ kind: 'callback' }))).askId).toBe('ask.callbackNumber');
    const prepared = data<Prepared>(await prepare(ctx, message({ kind: 'callback', customer: { phone: '555-010-0199' } })));
    expect(prepared.readback).toContain('callback at 555, 010, 0199');
    data<Committed>(await commit(ctx, prepared));
    expect(tickets.state.tickets.map((t) => t.contactPhone)).toEqual(['555-010-0199']);
    expect(tickets.state.tickets[0].description).not.toContain(NO_CALLBACK_NUMBER);
  });

  it('with no call or conversation to count asks against, the message is never held up for a number', async () => {
    const { prepare } = setup();
    const prepared = data<Prepared>(await prepare(agentCtx({ callId: undefined }), message()));
    expect(prepared.readback).toContain('no callback number');
  });
});

describe('tickets.message@1 in tickets.open.prepare: subject', () => {
  it('asks once in the call language, then exits per the contract with nothing prepared', async () => {
    const { tickets, prepare } = setup();
    const ctx = agentCtx({ locale: 'es-MX', callerPhone: '+15550100142' });
    const first = failure(await prepare(ctx, { kind: 'message' }));
    expect(first).toMatchObject({
      code: 'SLOT_MISSING',
      field: 'subject',
      askId: 'ask.messageSubject',
      retryable: true,
      callerSafeMessage: TICKETS_MESSAGE_V1.slots[0].defaultAsk.es,
    });
    const second = failure(await prepare(ctx, { kind: 'message', subject: '  ' }));
    expect(second).toMatchObject({
      code: 'SLOT_MISSING',
      field: 'subject',
      askId: 'ask.messageSubject',
      exit: 'message_ticket',
      retryable: false,
      callerSafeMessage: 'Le avisaré al equipo que llamó.',
    });
    expect(TICKETS_MESSAGE_V1.onFailure.SLOT_MISSING.map((s) => s.step)).toEqual([second.exit]);
    expect(tickets.state.tickets).toHaveLength(0);
  });
});

describe('outside tickets.message@1: unchanged', () => {
  // Today's error is runAction's: the first openPrepareInput issue's message and path.
  function todaysError(raw: unknown) {
    const parsed = openPrepareInput.safeParse(raw);
    if (parsed.success) throw new Error('expected today to reject this input');
    const issue = parsed.error.issues[0];
    return { code: 'VALIDATION_FAILED', message: issue.message, field: issue.path.join('.') };
  }

  it('a staff/UI actor without a phone, customer or subject is rejected exactly as today', async () => {
    const { tickets, prepare } = setup();
    const raws = [
      message({ kind: 'callback', customer: { name: 'Luis' } }),
      message({ customer: { name: 'Luis', phone: '   ' } }),
      message(),
      { kind: 'message', customer: { phone: '555-010-0142' } },
    ];
    for (const raw of raws) {
      expect(failure(await prepare(ownerCtx(), raw))).toMatchObject({ ...todaysError(raw), retryable: false });
    }
    expect(failure(await prepare(ownerCtx(), raws[0])).askId).toBeUndefined();
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('complaint and quote_request via the agent keep today\'s validation: no ask, no filing without a number', async () => {
    const { prepare, commit, tickets } = setup();
    for (const kind of ['complaint', 'quote_request']) {
      const ctx = agentCtx({ callerPhone: '+15550100142' });
      const noPhone = message({ kind });
      expect(failure(await prepare(ctx, noPhone))).toMatchObject(todaysError(noPhone));
      expect(failure(await prepare(ctx, noPhone))).toMatchObject(todaysError(noPhone));
      const noSubject = { kind, customer: { phone: '555-010-0142' } };
      expect(failure(await prepare(ctx, noSubject))).toMatchObject(todaysError(noSubject));
      data<Committed>(await commit(ctx, data<Prepared>(await prepare(ctx, message({ kind, customer: { phone: '555-010-0142' } })))));
    }
    expect(tickets.state.tickets.map((t) => [t.kind, t.contactPhone])).toEqual([
      ['complaint', '555-010-0142'],
      ['quote_request', '555-010-0142'],
    ]);
  });
});
