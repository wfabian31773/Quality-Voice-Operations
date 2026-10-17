import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, runAction, toAgentToolSchema, type ActionContext, type ActionResult } from '../core';
import { createMemoryTicketsRepo } from './__fixtures__/memoryRepo';
import { createTicketsActions, OPEN_COMMIT, OPEN_PREPARE } from './actions';
import { ticketsActions } from './index';
import { buildOpenReadback, normalizePhone, phoneDigitGroups } from './readback';
import { advisoryLockKey, parseTicketSettings } from './repo';
import { DEFAULT_INTAKE_SCHEMAS, intakeSchemaFor } from './intakeSchemas';
import { canTransition, STATUS_TRANSITIONS, TICKET_KINDS, TICKET_STATUSES } from './schemas';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const TENANT = 'tenant-a';
const OTHER = 'tenant-b';

const LAW_INTAKE_SCHEMA = {
  type: 'object' as const,
  properties: {
    matterType: { type: 'string' as const, enum: ['family', 'estate', 'injury'] },
    opposingParties: { type: 'array' as const, items: { type: 'string' as const }, maxItems: 5 },
    deadlineDays: { type: 'integer' as const, minimum: 0 },
  },
  required: ['matterType'],
};

function agentCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: TENANT,
    actor: { type: 'agent', id: 'agent-1' },
    now: NOW,
    tenantTimezone: 'America/New_York',
    callId: 'call-1',
    ...overrides,
  };
}

function ownerCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return agentCtx({ actor: { type: 'user', id: 'owner-1', role: 'tenant_owner' }, callId: undefined, ...overrides });
}

function setup() {
  const store = createMemoryStore();
  const tickets = createMemoryTicketsRepo();
  const registry = createTicketsActions({ repo: tickets.repo });
  const deps = { store, registry, withTenantTx: store.withTenantTx.bind(store) };
  // Each prepare is a fresh agent turn, so it gets its own idempotency key.
  const run = (name: string, ctx: ActionContext, input: unknown) =>
    runAction(
      name,
      name === OPEN_PREPARE && !ctx.idempotencyKey ? { ...ctx, idempotencyKey: randomUUID() } : ctx,
      input,
      deps,
    );
  return { store, tickets, run };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'callback',
    subject: 'the leaking sink',
    details: 'Water under the cabinet since this morning.',
    customer: { name: 'Luis', phone: '+1 (555) 010-0142' },
    ...overrides,
  };
}

function data<T = Record<string, unknown>>(result: ActionResult): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data as T;
}

function expectFail(result: ActionResult, code: string, field?: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  if (field) expect(result.error.field).toBe(field);
}

type Prepared = { confirmationToken: string; payloadHash: string; readback: string; expiresAt: string };
type Committed = { ticketId: string; ticketNumber: number | null; dueAt: string | null; deduped: boolean };

async function prepareAndCommit(
  run: ReturnType<typeof setup>['run'],
  input: Record<string, unknown> = baseInput(),
  ctx: ActionContext = agentCtx(),
) {
  const prepared = data<Prepared>(await run(OPEN_PREPARE, ctx, input));
  const committed = await run(OPEN_COMMIT, ctx, {
    confirmationToken: prepared.confirmationToken,
    payloadHash: prepared.payloadHash,
  });
  return { prepared, committed };
}

describe('tickets action registry', () => {
  it('registers the six ticket actions under the tickets tool', () => {
    expect(ticketsActions.map((def) => def.name)).toEqual([
      'tickets.open.prepare',
      'tickets.open.commit',
      'tickets.add_note',
      'tickets.update',
      'tickets.list',
      'tickets.get',
    ]);
    expect(ticketsActions.every((def) => def.tool === 'tickets')).toBe(true);
  });

  it('lets the agent open tickets but not update, note, list or read them', () => {
    const agentAllowed = ticketsActions.filter((def) => def.permissions.agent).map((def) => def.name);
    expect(agentAllowed).toEqual(['tickets.open.prepare', 'tickets.open.commit']);
  });

  it('generates an agent tool schema for open.prepare', () => {
    const prepare = ticketsActions.find((def) => def.name === OPEN_PREPARE)!;
    const schema = toAgentToolSchema(prepare);
    expect(schema.name).not.toContain('.');
    expect(JSON.stringify(schema.parameters)).toContain('callbackWindow');
    expect(JSON.stringify(schema.parameters)).not.toContain('intakeSchema');
  });
});

describe('tickets.open.prepare', () => {
  it('builds the readback server-side from tenant settings', async () => {
    const { tickets, run } = setup();
    tickets.state.settings.set(TENANT, {
      businessName: 'Dana Plumbing',
      ownerName: 'Dana',
      slaText: 'usually within 2 business hours',
      callbackSlaMinutes: null,
      intakeSchemas: {},
    });
    const result = await run(OPEN_PREPARE, agentCtx(), baseInput({ callbackWindow: 'today after 3' }));
    expect(result.ok && result.readback).toBe(
      "I'll pass this to Dana: a callback request about the leaking sink, callback at 555, 010, 0142, today after 3.",
    );
    expect(data<Prepared>(result).confirmationToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to SLA text, then the business name, and never invents a window', async () => {
    const settings = parseTicketSettings('Marco Barbers', { tickets: { slaText: 'usually within 2 business hours.' } });
    expect(buildOpenReadback({ ...baseInput(), kind: 'message', urgency: 'normal', details: '' } as never, settings)).toBe(
      "I'll pass this to Marco Barbers: a message about the leaking sink, callback at 555, 010, 0142, usually within 2 business hours.",
    );
    const bare = parseTicketSettings(null, {});
    expect(buildOpenReadback({ ...baseInput(), kind: 'intake', urgency: 'urgent', details: '' } as never, bare)).toBe(
      "I'll pass this to the team: an urgent intake request about the leaking sink, callback at 555, 010, 0142.",
    );
  });

  it('reads back the full callback number in digit groups', () => {
    expect(phoneDigitGroups('+1 (555) 010-0142')).toBe('555, 010, 0142');
    expect(phoneDigitGroups('555.010.0142')).toBe('555, 010, 0142');
    expect(phoneDigitGroups('15550100142')).toBe('555, 010, 0142');
    expect(phoneDigitGroups('010-0142')).toBe('010, 0142');
    expect(phoneDigitGroups('+44 20 7946 0958')).toBe('442, 079, 46, 0958');
    expect(phoneDigitGroups('12345678')).toBe('12, 34, 5678');
    const readback = buildOpenReadback(
      { ...baseInput({ customer: { phone: '(212) 555-0199' } }), kind: 'callback', urgency: 'normal', details: '' } as never,
      parseTicketSettings(null, {}),
    );
    expect(readback).toContain('callback at 212, 555, 0199');
    expect(readback).not.toMatch(/ending/);
  });

  it('rejects a subject over 120 characters and a phone with too few digits', async () => {
    const { run } = setup();
    expectFail(await run(OPEN_PREPARE, agentCtx(), baseInput({ subject: 'x'.repeat(121) })), 'VALIDATION_FAILED', 'subject');
    expectFail(
      await run(OPEN_PREPARE, agentCtx(), baseInput({ customer: { name: 'Luis', phone: '0142' } })),
      'VALIDATION_FAILED',
      'customer.phone',
    );
    expectFail(await run(OPEN_PREPARE, agentCtx(), baseInput({ kind: 'lawsuit' })), 'VALIDATION_FAILED', 'kind');
  });

  it('allows a caller who will not give a name', async () => {
    const { run } = setup();
    const { committed } = await prepareAndCommit(run, baseInput({ customer: { phone: '555-010-0142' } }));
    expect(data<Committed>(committed).deduped).toBe(false);
  });

  describe('intake validated by the server-side schema', () => {
    function withLawSchema() {
      const env = setup();
      env.tickets.state.settings.set(
        TENANT,
        parseTicketSettings('Law Office', { tickets: { intakeSchemas: { intake: LAW_INTAKE_SCHEMA } } }),
      );
      return env;
    }

    it("accepts intake that matches the tenant's configured schema", async () => {
      const { tickets, run } = withLawSchema();
      const { committed } = await prepareAndCommit(
        run,
        baseInput({ kind: 'intake', intake: { matterType: 'estate', opposingParties: ['R. Smith'], deadlineDays: 3 } }),
      );
      const { ticketId } = data<Committed>(committed);
      expect(tickets.state.tickets.find((t) => t.id === ticketId)?.intake).toEqual({
        matterType: 'estate',
        opposingParties: ['R. Smith'],
        deadlineDays: 3,
      });
    });

    it('rejects a missing required field', async () => {
      const { run } = withLawSchema();
      const result = await run(OPEN_PREPARE, agentCtx(), baseInput({ kind: 'intake', intake: { deadlineDays: 2 } }));
      expectFail(result, 'VALIDATION_FAILED', 'intake.matterType');
    });

    it('rejects a value outside the enum, a wrong type and an unknown field', async () => {
      const { run } = withLawSchema();
      for (const [intake, field] of [
        [{ matterType: 'criminal' }, 'intake.matterType'],
        [{ matterType: 'estate', deadlineDays: 'soon' }, 'intake.deadlineDays'],
        [{ matterType: 'estate', budget: 5000 }, 'intake.budget'],
      ] as const) {
        const result = await run(OPEN_PREPARE, agentCtx(), baseInput({ kind: 'intake', intake }));
        expectFail(result, 'VALIDATION_FAILED', field);
      }
    });

    it('ignores a caller-supplied intakeSchema; the server schema still decides', async () => {
      const { tickets, run } = withLawSchema();
      const lax = { properties: { budget: { type: 'number' } }, additionalProperties: true };
      expectFail(
        await run(OPEN_PREPARE, agentCtx(), baseInput({ kind: 'intake', intakeSchema: lax, intake: { budget: 5000 } })),
        'VALIDATION_FAILED',
        'intake.matterType',
      );
      // Without a tenant schema the built-in default applies: a callback takes no intake fields.
      expectFail(
        await run(OPEN_PREPARE, agentCtx(), baseInput({ intakeSchema: lax, intake: { budget: 5000 } })),
        'VALIDATION_FAILED',
        'intake.budget',
      );
      expect(tickets.state.tickets).toHaveLength(0);
    });

    describe('extra fields when the tenant schema allows additionalProperties', () => {
      function withOpenSchema() {
        const env = setup();
        env.tickets.state.settings.set(
          TENANT,
          parseTicketSettings('Law Office', {
            tickets: { intakeSchemas: { intake: { ...LAW_INTAKE_SCHEMA, additionalProperties: true } } },
          }),
        );
        return env;
      }
      const open = (run: ReturnType<typeof setup>['run'], extra: Record<string, unknown>) =>
        run(OPEN_PREPARE, agentCtx(), baseInput({ kind: 'intake', intake: { matterType: 'estate', ...extra } }));

      it('keeps plain JSON extras in the ticket intake, trimmed', async () => {
        const { tickets, run } = withOpenSchema();
        const extra = { courtName: '  County Probate  ', hearing_count: 2, urgent: false, note: null, tags: ['a', 1], who: { name: 'R' } };
        const { committed } = await prepareAndCommit(run, baseInput({ kind: 'intake', intake: { matterType: 'estate', ...extra } }));
        const { ticketId } = data<Committed>(committed);
        expect(tickets.state.tickets.find((t) => t.id === ticketId)?.intake).toEqual({
          matterType: 'estate',
          courtName: 'County Probate',
          hearing_count: 2,
          urgent: false,
          note: null,
          tags: ['a', 1],
          who: { name: 'R' },
        });
      });

      it('still rejects extras when additionalProperties is not true', async () => {
        const { run } = withLawSchema();
        expectFail(await open(run, { courtName: 'County Probate' }), 'VALIDATION_FAILED', 'intake.courtName');
      });

      it('rejects extras over the caps instead of dropping them', async () => {
        const { tickets, run } = withOpenSchema();
        const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`extra${i}`, 'x']));
        for (const [extra, field] of [
          [{ courtName: 'x'.repeat(2001) }, 'intake.courtName'],
          [{ nested: { deep: { deeper: 1 } } }, 'intake.nested'],
          [{ list: [['a']] }, 'intake.list'],
          [{ list: Array.from({ length: 21 }, () => 'a') }, 'intake.list'],
          [{ obj: { 'bad key': 1 } }, 'intake.obj'],
          [{ 'bad-key': 'x' }, 'intake'],
          [{ _private: 'x' }, 'intake'],
          [many, 'intake'],
          [{ a: 'x'.repeat(2000), b: 'x'.repeat(2000), c: 'x'.repeat(2000), d: 'x'.repeat(2000), e: 'x'.repeat(2000) }, 'intake'],
        ] as const) {
          expectFail(await open(run, extra), 'VALIDATION_FAILED', field);
        }
        expect(tickets.state.tickets).toHaveLength(0);
        // Exactly at the key cap is fine.
        const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`extra${i}`, 'x']));
        expect((await open(run, twenty)).ok).toBe(true);
      });
    });

    it('uses the built-in default schema per kind when the tenant has none', async () => {
      const { tickets, run } = setup();
      const { committed } = await prepareAndCommit(
        run,
        baseInput({ kind: 'quote_request', intake: { serviceType: 'bathroom remodel', timeframe: 'next month' } }),
      );
      const { ticketId } = data<Committed>(committed);
      expect(tickets.state.tickets.find((t) => t.id === ticketId)?.intake).toEqual({
        serviceType: 'bathroom remodel',
        timeframe: 'next month',
      });
      expectFail(
        await run(OPEN_PREPARE, agentCtx(), baseInput({ kind: 'quote_request', intake: { ssn: '123' } })),
        'VALIDATION_FAILED',
        'intake.ssn',
      );
      expect(intakeSchemaFor('message', {})).toBe(DEFAULT_INTAKE_SCHEMAS.message);
      expect(Object.keys(DEFAULT_INTAKE_SCHEMAS).sort()).toEqual([...TICKET_KINDS].sort());
    });

    it('fails closed to "no intake fields" when the configured schema is malformed', async () => {
      const { tickets, run } = setup();
      tickets.state.settings.set(
        TENANT,
        parseTicketSettings('Shop', { tickets: { intakeSchemas: { quote_request: { properties: { x: { type: 'object' } } } } } }),
      );
      expectFail(
        await run(OPEN_PREPARE, agentCtx(), baseInput({ kind: 'quote_request', intake: { serviceType: 'deck' } })),
        'VALIDATION_FAILED',
        'intake.serviceType',
      );
      data(await run(OPEN_PREPARE, agentCtx(), baseInput({ kind: 'quote_request' })));
    });
  });
});

describe('tickets.open.commit', () => {
  it('creates one ticket, links the call, and writes ticket.opened to the outbox', async () => {
    const { tickets, run } = setup();
    const { prepared, committed } = await prepareAndCommit(run);
    const { ticketId } = data<Committed>(committed);
    expect(tickets.state.outbox).toEqual([
      {
        id: expect.any(String),
        tenantId: TENANT,
        status: 'pending',
        eventType: 'ticket.opened',
        payload: expect.objectContaining({
          ticketId,
          kind: 'callback',
          urgency: 'normal',
          callId: 'call-1',
          proposalId: prepared.confirmationToken,
          idempotencyKey: prepared.confirmationToken,
        }),
      },
    ]);
    // The effect mirrors the outbox row (informational only; never dispatched from).
    expect(committed.ok && committed.effects).toEqual([
      {
        type: 'ticket.opened',
        payload: { ...tickets.state.outbox[0].payload, outboxId: tickets.state.outbox[0].id },
      },
    ]);
    expect(tickets.state.tickets).toHaveLength(1);
    const [ticket] = tickets.state.tickets;
    expect(ticket).toMatchObject({
      kind: 'callback',
      status: 'open',
      priority: 'medium',
      sourceCallRef: 'call-1',
      contactName: 'Luis',
      contactPhone: '+1 (555) 010-0142',
      callbackDueAt: null,
    });
    expect(tickets.state.activities.map((a) => a.type)).toEqual(['created']);
  });

  it('sets callback_due_at from the tenant SLA config and leaves it null without one', async () => {
    const withSettings = setup();
    withSettings.tickets.state.settings.set(TENANT, parseTicketSettings('Shop', { tickets: { callbackSlaMinutes: 120 } }));
    const a = data<Committed>((await prepareAndCommit(withSettings.run)).committed);
    expect(a.dueAt).toBe('2026-10-17T17:00:00.000Z');

    const withPolicy = setup();
    withPolicy.tickets.state.slaMinutes.set(TENANT, { urgent: 30 });
    const b = data<Committed>((await prepareAndCommit(withPolicy.run, baseInput({ urgency: 'urgent' }))).committed);
    expect(b.dueAt).toBe('2026-10-17T15:30:00.000Z');
    expect(withPolicy.tickets.state.tickets[0].priority).toBe('urgent');

    const none = setup();
    const c = data<Committed>((await prepareAndCommit(none.run)).committed);
    expect(c.dueAt).toBeNull();
  });

  it('ignores invalid SLA minutes in settings', () => {
    expect(parseTicketSettings('x', { tickets: { callbackSlaMinutes: -5 } }).callbackSlaMinutes).toBeNull();
    expect(parseTicketSettings('x', { tickets: { callbackSlaMinutes: '120' } }).callbackSlaMinutes).toBeNull();
    expect(parseTicketSettings('x', 'not json').callbackSlaMinutes).toBeNull();
  });

  describe('dedupe within one call', () => {
    it('turns a repeat of the same kind and phone into a note on the first ticket', async () => {
      const { tickets, run } = setup();
      const first = data<Committed>((await prepareAndCommit(run)).committed);
      const second = await prepareAndCommit(
        run,
        baseInput({ subject: 'the sink again', customer: { name: 'Luis', phone: '555.010.0142' } }),
      );
      const third = await prepareAndCommit(run, baseInput({ subject: 'sink, third time' }));

      expect(data<Committed>(second.committed)).toEqual({ ...first, deduped: true });
      expect(data<Committed>(third.committed)).toEqual({ ...first, deduped: true });
      expect(second.committed.ok && second.committed.effects).toBeFalsy();
      expect(tickets.state.tickets).toHaveLength(1);
      expect(tickets.state.outbox.map((row) => row.payload.ticketId)).toEqual([first.ticketId]);
      const notes = tickets.state.activities.filter((a) => a.type === 'note');
      expect(notes).toHaveLength(2);
      expect(notes[0]).toMatchObject({ ticketId: first.ticketId, metadata: { dedupe: true } });
      expect(notes[0].content).toContain('the sink again');
      expect(tickets.state.locks).toHaveLength(3);
    });

    it('raises the first ticket to urgent when the repeat is urgent', async () => {
      const { tickets, run } = setup();
      await prepareAndCommit(run);
      await prepareAndCommit(run, baseInput({ urgency: 'urgent', subject: 'now it is flooding' }));
      expect(tickets.state.tickets).toHaveLength(1);
      expect(tickets.state.tickets[0]).toMatchObject({ urgency: 'urgent', priority: 'urgent' });
      expect(tickets.state.activities.map((a) => a.type)).toEqual(['created', 'note', 'priority_change']);
    });

    it('keeps separate tickets for a different kind, a different phone, or a different call', async () => {
      const { tickets, run } = setup();
      await prepareAndCommit(run);
      await prepareAndCommit(run, baseInput({ kind: 'complaint' }));
      await prepareAndCommit(run, baseInput({ customer: { name: 'Ana', phone: '555-010-9999' } }));
      await prepareAndCommit(run, baseInput(), agentCtx({ callId: 'call-2' }));
      expect(tickets.state.tickets).toHaveLength(4);
    });

    it('does not dedupe UI-opened tickets that have no call', async () => {
      const { tickets, run } = setup();
      await prepareAndCommit(run, baseInput(), ownerCtx());
      await prepareAndCommit(run, baseInput(), ownerCtx());
      expect(tickets.state.tickets).toHaveLength(2);
      expect(tickets.state.tickets.every((t) => t.sourceCallRef === null)).toBe(true);
    });
  });

  it('replays an idempotent commit retry without running it again: one ticket, one outbox row', async () => {
    const { tickets, run } = setup();
    const { prepared, committed } = await prepareAndCommit(run);
    const commitInput = { confirmationToken: prepared.confirmationToken, payloadHash: prepared.payloadHash };
    const retry = await run(OPEN_COMMIT, agentCtx(), commitInput);
    expect(retry).toEqual(committed);
    expect(tickets.state.tickets).toHaveLength(1);
    expect(tickets.state.activities).toHaveLength(1);
    expect(tickets.state.outbox).toHaveLength(1);

    // A different idempotency key can't reuse the consumed token either.
    const otherKey = await run(OPEN_COMMIT, agentCtx({ idempotencyKey: randomUUID() }), commitInput);
    expectFail(otherKey, 'CONFIRMATION_INVALID');
    expect(tickets.state.tickets).toHaveLength(1);
    expect(tickets.state.outbox).toHaveLength(1);
  });

  it('returns CONFIRMATION_INVALID for an expired token and creates nothing', async () => {
    const { tickets, run } = setup();
    const prepared = data<Prepared>(await run(OPEN_PREPARE, agentCtx(), baseInput()));
    const late = agentCtx({ now: new Date(NOW.getTime() + 5 * 60_000 + 1) });
    const result = await run(OPEN_COMMIT, late, {
      confirmationToken: prepared.confirmationToken,
      payloadHash: prepared.payloadHash,
    });
    expectFail(result, 'CONFIRMATION_INVALID');
    if (!result.ok) expect(result.error.message).toMatch(/expired/);
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('returns CONFIRMATION_INVALID for a token from another call or a changed payload', async () => {
    const { tickets, run } = setup();
    const prepared = data<Prepared>(await run(OPEN_PREPARE, agentCtx(), baseInput()));
    expectFail(
      await run(OPEN_COMMIT, agentCtx({ callId: 'call-other' }), {
        confirmationToken: prepared.confirmationToken,
        payloadHash: prepared.payloadHash,
      }),
      'CONFIRMATION_INVALID',
    );
    expectFail(
      await run(OPEN_COMMIT, agentCtx(), { confirmationToken: prepared.confirmationToken, payloadHash: 'f'.repeat(64) }),
      'CONFIRMATION_INVALID',
    );
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it("does not let one tenant commit another tenant's token", async () => {
    const { tickets, run } = setup();
    const prepared = data<Prepared>(await run(OPEN_PREPARE, agentCtx(), baseInput()));
    expectFail(
      await run(OPEN_COMMIT, agentCtx({ tenantId: OTHER }), {
        confirmationToken: prepared.confirmationToken,
        payloadHash: prepared.payloadHash,
      }),
      'CONFIRMATION_INVALID',
    );
    expect(tickets.state.tickets).toHaveLength(0);
  });
});

describe('tickets.add_note', () => {
  it('adds a note and returns NOT_FOUND for a missing or foreign ticket', async () => {
    const { tickets, run } = setup();
    const { ticketId } = data<Committed>((await prepareAndCommit(run)).committed);
    const ok = await run('tickets.add_note', ownerCtx({ idempotencyKey: 'n1' }), { ticketId, note: 'Called back, left voicemail' });
    expect(data(ok)).toEqual({ ticketId, noted: true });
    expect(tickets.state.activities.at(-1)).toMatchObject({ type: 'note', actorUserId: 'owner-1' });

    expectFail(
      await run('tickets.add_note', ownerCtx({ idempotencyKey: 'n2' }), { ticketId: 'missing', note: 'x' }),
      'NOT_FOUND',
    );
    expectFail(
      await run('tickets.add_note', ownerCtx({ tenantId: OTHER, idempotencyKey: 'n3' }), { ticketId, note: 'x' }),
      'NOT_FOUND',
    );
  });

  it('is not available to the agent', async () => {
    const { run } = setup();
    expectFail(
      await run('tickets.add_note', agentCtx({ idempotencyKey: 'n1' }), { ticketId: 't', note: 'x' }),
      'FORBIDDEN',
    );
  });
});

describe('tickets.update', () => {
  async function opened() {
    const env = setup();
    const { ticketId } = data<Committed>((await prepareAndCommit(env.run)).committed);
    let key = 0;
    const update = (input: Record<string, unknown>, ctx: Partial<ActionContext> = {}) =>
      env.run('tickets.update', ownerCtx({ idempotencyKey: `u${(key += 1)}`, ...ctx }), { ticketId, ...input });
    return { ...env, ticketId, update };
  }

  it('walks open → in_progress → resolved → closed → reopened', async () => {
    const { tickets, update } = await opened();
    for (const status of ['in_progress', 'resolved', 'closed', 'reopened'] as const) {
      expect(data<{ status: string }>(await update({ status })).status).toBe(status);
    }
    const changes = tickets.state.activities.filter((a) => a.type === 'status_change');
    expect(changes.map((a) => `${a.oldValue}->${a.newValue}`)).toEqual([
      'open->in_progress',
      'in_progress->resolved',
      'resolved->closed',
      'closed->reopened',
    ]);
  });

  it('rejects invalid transitions', async () => {
    const { update } = await opened();
    data(await update({ status: 'closed' }));
    expectFail(await update({ status: 'in_progress' }), 'VALIDATION_FAILED', 'status');
    expectFail(await update({ status: 'open' }), 'VALIDATION_FAILED', 'status');
    expectFail(await update({ status: 'resolved' }), 'VALIDATION_FAILED', 'status');
  });

  it('encodes the transition table', () => {
    for (const from of TICKET_STATUSES) {
      expect(canTransition(from, from)).toBe(true);
      expect(STATUS_TRANSITIONS[from]).not.toContain('open');
    }
    expect(canTransition('resolved', 'in_progress')).toBe(false);
    expect(canTransition('closed', 'reopened')).toBe(true);
  });

  it('assigns only tenant members, sets priority and due date, and validates input', async () => {
    const { tickets, update } = await opened();
    tickets.state.members.set(TENANT, new Set(['staff-1']));
    expectFail(await update({ assigneeId: 'stranger' }), 'VALIDATION_FAILED', 'assigneeId');
    const updated = data<{ assigneeId: string; priority: string; callbackDueAt: string; overdue: boolean }>(
      await update({ assigneeId: 'staff-1', priority: 'high', dueAt: '2026-10-17T14:00:00Z' }),
    );
    expect(updated).toMatchObject({
      assigneeId: 'staff-1',
      priority: 'high',
      callbackDueAt: '2026-10-17T14:00:00.000Z',
      overdue: true,
    });
    expect(tickets.state.activities.map((a) => a.type)).toEqual(['created', 'priority_change', 'assigned', 'field_change']);
    expect(data<{ assigneeId: null }>(await update({ assigneeId: null })).assigneeId).toBeNull();
    expectFail(await update({}), 'VALIDATION_FAILED');
    expectFail(await update({ dueAt: 'tomorrow' }), 'VALIDATION_FAILED', 'dueAt');
  });

  it('is UI/MCP only and returns NOT_FOUND across tenants', async () => {
    const { run, ticketId, update } = await opened();
    expectFail(
      await run('tickets.update', agentCtx({ idempotencyKey: 'a1' }), { ticketId, status: 'closed' }),
      'FORBIDDEN',
    );
    expectFail(
      await run('tickets.update', ownerCtx({ actor: { type: 'user', id: 'v', role: 'viewer' }, idempotencyKey: 'v1' }), {
        ticketId,
        status: 'closed',
      }),
      'FORBIDDEN',
    );
    const mcp = await run(
      'tickets.update',
      ownerCtx({ actor: { type: 'mcp', id: 'bot', scopes: ['qvo:admin'] }, idempotencyKey: 'm1' }),
      { ticketId, status: 'in_progress' },
    );
    expect(data<{ status: string }>(mcp).status).toBe('in_progress');
    expectFail(await update({ status: 'closed' }, { tenantId: OTHER }), 'NOT_FOUND');
  });
});

describe('tickets.list and tickets.get', () => {
  it('filters open, overdue and kind', async () => {
    const { tickets, run } = setup();
    tickets.state.settings.set(TENANT, parseTicketSettings('Shop', { tickets: { callbackSlaMinutes: 60 } }));
    const callback = data<Committed>((await prepareAndCommit(run)).committed);
    const complaint = data<Committed>((await prepareAndCommit(run, baseInput({ kind: 'complaint' }))).committed);
    await run('tickets.update', ownerCtx({ idempotencyKey: 'c' }), { ticketId: complaint.ticketId, status: 'resolved' });

    const later = ownerCtx({ now: new Date(NOW.getTime() + 2 * 60 * 60_000) });
    const ids = async (input: Record<string, unknown>, ctx = ownerCtx()) =>
      data<{ tickets: Array<{ id: string }> }>(await run('tickets.list', ctx, input)).tickets.map((t) => t.id);

    expect(await ids({})).toEqual([callback.ticketId]);
    expect((await ids({ status: 'all' })).sort()).toEqual([callback.ticketId, complaint.ticketId].sort());
    expect(await ids({ status: 'overdue' })).toEqual([]);
    expect(await ids({ status: 'overdue' }, later)).toEqual([callback.ticketId]);
    expect(await ids({ status: 'all', kind: 'complaint' })).toEqual([complaint.ticketId]);
    expect(await ids({ status: 'all' }, ownerCtx({ tenantId: OTHER }))).toEqual([]);
  });

  it('gets a ticket with the linked call reference, intake and notes', async () => {
    const { run } = setup();
    const { ticketId } = data<Committed>((await prepareAndCommit(run)).committed);
    await prepareAndCommit(run, baseInput({ subject: 'repeat' }));
    const detail = data<Record<string, unknown>>(await run('tickets.get', ownerCtx(), { ticketId }));
    expect(detail).toMatchObject({
      id: ticketId,
      kind: 'callback',
      sourceCallRef: 'call-1',
      intake: {},
      details: 'Water under the cabinet since this morning.',
    });
    expect(detail.notes).toHaveLength(1);
    expectFail(await run('tickets.get', ownerCtx({ tenantId: OTHER }), { ticketId }), 'NOT_FOUND');
    expectFail(await run('tickets.get', agentCtx(), { ticketId }), 'FORBIDDEN');
  });
});

describe('helpers', () => {
  it('normalizes phones for dedupe', () => {
    expect(normalizePhone('+1 (555) 010-0142')).toBe('5550100142');
    expect(normalizePhone('555.010.0142')).toBe('5550100142');
    expect(normalizePhone('+44 20 7946 0958')).toBe('442079460958');
  });

  it('derives a stable signed 64-bit advisory lock key', () => {
    const key = advisoryLockKey('tenant|call|callback|5550100142');
    expect(key).toBe(advisoryLockKey('tenant|call|callback|5550100142'));
    expect(key).not.toBe(advisoryLockKey('tenant|call|complaint|5550100142'));
    expect(BigInt(key) >= -(2n ** 63n) && BigInt(key) < 2n ** 63n).toBe(true);
  });
});
