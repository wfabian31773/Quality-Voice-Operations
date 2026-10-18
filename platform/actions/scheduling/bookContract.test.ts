// booking.book@1 enforced inside scheduling.book.prepare (RT-01): a partial
// payload reaches run and comes back SLOT_MISSING with the next askId in the
// contract's ask order; the same slot missing twice in one call exits to a
// message. Runs on the in-memory action store (no database).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BOOKING_BOOK_V1 } from '../../callcore/contracts';
import {
  createMemoryStore,
  runActionDefinition,
  toAgentToolSchema,
  toHttpHandler,
  type ActionContext,
  type ActionResult,
} from '../core';
import { bookPrepareAction } from './book';

const START = '2026-10-20T15:30:00-04:00';
const SERVICE_ONLY = { serviceIds: ['svc-cut'] };
const NO_NAME = { serviceIds: ['svc-cut'], staffId: 'any', start: START };

function agentCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: 'tenant-rt01',
    actor: { type: 'agent', id: 'agent-1' },
    now: new Date('2026-10-19T12:00:00Z'),
    tenantTimezone: 'America/New_York',
    callId: `call-${randomUUID()}`,
    // Each tool call carries its own key, like a per-invocation adapter.
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function prepare(input: unknown, ctx: ActionContext = agentCtx()): Promise<ActionResult> {
  const store = createMemoryStore();
  return runActionDefinition(bookPrepareAction, { ...ctx, idempotencyKey: ctx.idempotencyKey ?? randomUUID() }, input, {
    store,
    withTenantTx: store.withTenantTx.bind(store),
  });
}

function refusal(result: ActionResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

describe('scheduling.book.prepare enforces booking.book@1', () => {
  it('asks for the service first when nothing is given', async () => {
    const error = refusal(await prepare({}));
    expect(error).toMatchObject({
      code: 'SLOT_MISSING',
      field: 'service',
      askId: 'ask.service',
      retryable: true,
      callerSafeMessage: BOOKING_BOOK_V1.slots[0].defaultAsk.en,
    });
    expect(error.exit).toBeUndefined();
  });

  it('with service only, asks for the staff member next', async () => {
    const error = refusal(await prepare(SERVICE_ONLY));
    expect(error).toMatchObject({ code: 'SLOT_MISSING', field: 'staff', askId: 'ask.staff', retryable: true });
  });

  it('with service, staff and time but no name, asks for the name', async () => {
    const error = refusal(await prepare(NO_NAME));
    expect(error).toMatchObject({ code: 'SLOT_MISSING', field: 'customerName', askId: 'ask.customerName', retryable: true });
  });

  it('treats blank strings and an empty service list as not given', async () => {
    expect(refusal(await prepare({ serviceIds: [], staffId: '', start: '' })).askId).toBe('ask.service');
    expect(refusal(await prepare({ ...NO_NAME, customer: { name: '  ' } })).askId).toBe('ask.customerName');
  });

  it('still validates the format of values that are present', async () => {
    const badPhone = refusal(await prepare({ ...NO_NAME, customer: { name: 'Luis', phone: '12' } }));
    expect(badPhone.code).toBe('VALIDATION_FAILED');
    expect(badPhone.field).toBe('customer.phone');
    const badStart = refusal(await prepare({ serviceIds: ['svc-cut'], staffId: 'any', start: 'tomorrow at 3' }));
    expect(badStart).toMatchObject({ code: 'VALIDATION_FAILED', field: 'start' });
    const tooMany = refusal(await prepare({ serviceIds: ['a', 'b', 'c', 'd'] }));
    expect(tooMany).toMatchObject({ code: 'VALIDATION_FAILED', field: 'serviceIds' });
  });

  it('one ask per slot: the same slot missing twice in one call exits to a message', async () => {
    const ctx = agentCtx();
    const first = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
    expect(first).toMatchObject({ askId: 'ask.staff', retryable: true });
    expect(first.exit).toBeUndefined();

    const second = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
    expect(second).toMatchObject({
      code: 'SLOT_MISSING',
      field: 'staff',
      askId: 'ask.staff',
      exit: 'message_ticket',
      retryable: false,
    });
    expect(second.callerSafeMessage).toMatch(/message/i);
  });

  it('counts per slot: a different missing slot in the same call is still its first ask', async () => {
    const ctx = agentCtx();
    refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
    const next = refusal(await prepare({ ...SERVICE_ONLY, staffId: 'any' }, { ...ctx, idempotencyKey: randomUUID() }));
    expect(next).toMatchObject({ askId: 'ask.time', retryable: true });
    expect(next.exit).toBeUndefined();
  });

  it('a different callId starts fresh', async () => {
    const ctx = agentCtx();
    await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() });
    expect(refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() })).exit).toBe('message_ticket');

    const other = refusal(await prepare(SERVICE_ONLY, { ...ctx, callId: `call-${randomUUID()}`, idempotencyKey: randomUUID() }));
    expect(other).toMatchObject({ askId: 'ask.staff', retryable: true });
    expect(other.exit).toBeUndefined();
  });

  it('a complete prepare clears the call\'s counts, so a later booking asks again before exiting', async () => {
    const ctx = agentCtx();
    expect(refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() })).askId).toBe('ask.staff');
    const full = { ...NO_NAME, customer: { name: 'Luis', phone: '+15555550142' } };
    // Complete payload: past the contract to the (empty) memory-store catalog.
    expect(refusal(await prepare(full, { ...ctx, idempotencyKey: randomUUID() })).code).not.toBe('SLOT_MISSING');

    const again = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
    expect(again).toMatchObject({ code: 'SLOT_MISSING', askId: 'ask.staff', retryable: true });
    expect(again.exit).toBeUndefined();
  });

  it('a retry of the same tool call (same idempotency key) counts once', async () => {
    const ctx = agentCtx();
    const key = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: key }));
      expect(retry).toMatchObject({ askId: 'ask.staff', retryable: true });
      expect(retry.exit).toBeUndefined();
    }
    const next = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
    expect(next).toMatchObject({ askId: 'ask.staff', exit: 'message_ticket', retryable: false });
  });

  it('treats null as not given', async () => {
    const error = refusal(await prepare({ ...SERVICE_ONLY, staffId: null }));
    expect(error).toMatchObject({ code: 'SLOT_MISSING', field: 'staff', askId: 'ask.staff' });
  });

  it('treats a null customer object as not given', async () => {
    const error = refusal(await prepare({
      serviceIds: ['svc-cut'], staffId: 'any', start: '2026-10-20T15:30:00-04:00', customer: null,
    }));
    expect(error).toMatchObject({ code: 'SLOT_MISSING', field: 'customerName', askId: 'ask.customerName' });
  });

  it('counts expire after the TTL: 31 minutes later is a first ask again', async () => {
    const ctx = agentCtx();
    await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() });
    const later = new Date(ctx.now.getTime() + 31 * 60_000);
    const fresh = refusal(await prepare(SERVICE_ONLY, { ...ctx, now: later, idempotencyKey: randomUUID() }));
    expect(fresh).toMatchObject({ askId: 'ask.staff', retryable: true });
    expect(fresh.exit).toBeUndefined();
  });

  it('counts are per tenant: the same callId on another tenant starts fresh', async () => {
    const ctx = agentCtx();
    await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() });
    const other = refusal(await prepare(SERVICE_ONLY, { ...ctx, tenantId: 'tenant-rt01-other', idempotencyKey: randomUUID() }));
    expect(other).toMatchObject({ askId: 'ask.staff', retryable: true });
    expect(other.exit).toBeUndefined();
  });

  describe('sessions without a callId', () => {
    const convCtx = () => agentCtx({ callId: undefined, conversationId: `conv-${randomUUID()}` });

    it('counts per conversationId: the same slot missing twice exits to a message', async () => {
      const ctx = convCtx();
      const first = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
      expect(first).toMatchObject({ askId: 'ask.staff', retryable: true });
      expect(first.exit).toBeUndefined();
      const second = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
      expect(second).toMatchObject({ askId: 'ask.staff', exit: 'message_ticket', retryable: false });
    });

    it('a complete prepare clears the conversation\'s counts', async () => {
      const ctx = convCtx();
      await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() });
      const full = { ...NO_NAME, customer: { name: 'Luis', phone: '+15555550142' } };
      expect(refusal(await prepare(full, { ...ctx, idempotencyKey: randomUUID() })).code).not.toBe('SLOT_MISSING');
      const again = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
      expect(again).toMatchObject({ askId: 'ask.staff', retryable: true });
      expect(again.exit).toBeUndefined();
    });

    it('a different conversationId starts fresh', async () => {
      const ctx = convCtx();
      await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() });
      const other = refusal(await prepare(SERVICE_ONLY, { ...convCtx(), idempotencyKey: randomUUID() }));
      expect(other).toMatchObject({ askId: 'ask.staff', retryable: true });
      expect(other.exit).toBeUndefined();
    });

    it('with neither callId nor conversationId, nothing is counted and it never exits', async () => {
      const ctx = agentCtx({ callId: undefined, conversationId: undefined });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ask = refusal(await prepare(SERVICE_ONLY, { ...ctx, idempotencyKey: randomUUID() }));
        expect(ask).toMatchObject({ askId: 'ask.staff', retryable: true });
        expect(ask.exit).toBeUndefined();
      }
    });
  });

  it('speaks the Spanish ask when the call locale is Spanish', async () => {
    const error = refusal(await prepare(SERVICE_ONLY, agentCtx({ locale: 'es-MX' })));
    expect(error.callerSafeMessage).toBe(BOOKING_BOOK_V1.slots[1].defaultAsk.es);
    const exitCtx = agentCtx({ locale: 'es' });
    await prepare(SERVICE_ONLY, { ...exitCtx, idempotencyKey: randomUUID() });
    const exit = refusal(await prepare(SERVICE_ONLY, { ...exitCtx, idempotencyKey: randomUUID() }));
    expect(exit.callerSafeMessage).toMatch(/mensaje/);
  });

  it('the server-held caller phone fills customerPhone without an ask', async () => {
    const withName = { ...NO_NAME, customer: { name: 'Luis' } };
    expect(refusal(await prepare(withName)).askId).toBe('ask.customerPhone');
    // With the held phone the contract is satisfied, so prepare goes on to the
    // catalog (empty in the memory store) instead of asking.
    const held = refusal(await prepare(withName, agentCtx({ callerPhone: '+15555550142' })));
    expect(held.code).not.toBe('SLOT_MISSING');
    expect(held).toMatchObject({ code: 'VALIDATION_FAILED', field: 'serviceIds' });
  });

  it('UI and MCP callers get SLOT_MISSING as a 4xx too', async () => {
    const store = createMemoryStore();
    const handler = toHttpHandler(bookPrepareAction, { store, withTenantTx: store.withTenantTx.bind(store) });
    const res = await handler({
      body: SERVICE_ONLY,
      headers: { 'Idempotency-Key': randomUUID() },
      tenantId: 'tenant-rt01',
      actor: { type: 'user', id: 'owner-1', role: 'tenant_owner' },
      tenantTimezone: 'America/New_York',
      now: new Date('2026-10-19T12:00:00Z'),
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'SLOT_MISSING', askId: 'ask.staff' } });
  });
});

describe('generated agent schema for scheduling.book.prepare', () => {
  const schema = toAgentToolSchema(bookPrepareAction);
  const params = schema.parameters as {
    required?: string[];
    properties: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    strict?: unknown;
  };

  it('lists no contract slot as required and is never strict', () => {
    expect(params.required ?? []).toEqual([]);
    expect(params.properties.customer.required ?? []).toEqual([]);
    expect(Object.keys(params.properties).sort()).toEqual(['customer', 'notes', 'serviceIds', 'staffId', 'start']);
    expect(Object.keys(params.properties.customer.properties ?? {}).sort()).toEqual(['email', 'name', 'phone']);
    expect(JSON.stringify(schema)).not.toMatch(/"strict":\s*true/);
    expect(params.strict).toBeUndefined();
  });
});
