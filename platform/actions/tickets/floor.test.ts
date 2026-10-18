import { describe, expect, it } from 'vitest';
import { createMemoryStore, runAction, type ActionContext, type ActionResult } from '../core';
import { createMemoryTicketsRepo } from './__fixtures__/memoryRepo';
import { createTicketsActions } from './actions';
import {
  NUMBER_MASK,
  FILE_FLOOR,
  FLOOR_SUBJECT,
  SSN_MASK,
  floorIdempotencyKey,
  redactCallerLines,
  redactCallerText,
} from './floor';
import { ticketsActions } from './index';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const TENANT = 'tenant-a';
const OTHER = 'tenant-b';
const CALL = 'CA-floor-1';

function systemCtx(callId = CALL, overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: TENANT,
    actor: { type: 'system', id: 'voice-runtime' },
    now: NOW,
    tenantTimezone: 'America/New_York',
    callId,
    idempotencyKey: floorIdempotencyKey(callId),
    ...overrides,
  };
}

type FloorData = { filed: boolean; reason: string; ticketId?: string; ticketNumber?: number | null };

function setup(decrypt?: (tenantId: string, stored: string) => Promise<string | null>) {
  const store = createMemoryStore();
  const tickets = createMemoryTicketsRepo();
  const registry = createTicketsActions({ repo: tickets.repo, decryptCallerNumber: decrypt ?? (async () => null) });
  const deps = { store, registry, withTenantTx: store.withTenantTx.bind(store) };
  const floor = (input: Record<string, unknown>, ctx: ActionContext = systemCtx(String(input.callId ?? CALL))) =>
    runAction(FILE_FLOOR, ctx, { callId: CALL, ...input }, deps);
  return { store, tickets, floor };
}

function data(result: ActionResult): FloorData {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data as FloorData;
}

function expectFail(result: ActionResult, code: string, field?: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  if (field) expect(result.error.field).toBe(field);
}

describe('tickets.file_floor registration', () => {
  it('is a system-only write in the tickets list, hidden from the agent and MCP', () => {
    const def = ticketsActions.find((d) => d.name === FILE_FLOOR)!;
    expect(def).toBeDefined();
    expect(def.tool).toBe('tickets');
    expect(def.kind).toBe('write');
    expect(def.permissions.agent).toBe(false);
    expect(def.permissions.mcpScope).toBeUndefined();
    expect(def.permissions.roles).toEqual([]);
  });
});

describe('tickets.file_floor rules', () => {
  it('empty lines → never_heard, nothing filed', async () => {
    const { tickets, floor } = setup();
    expect(data(await floor({ callerLines: [] }))).toEqual({ filed: false, reason: 'never_heard' });
    expect(data(await floor({ callId: 'CA-blank', callerLines: ['', '   '] }))).toEqual({ filed: false, reason: 'never_heard' });
    expect(tickets.state.tickets).toHaveLength(0);
    expect(tickets.state.outbox).toHaveLength(0);
  });

  it('only "hi, this is Luis" → nothing_substantive', async () => {
    const { tickets, floor } = setup();
    expect(data(await floor({ callerLines: ['Hi, this is Luis.'] }))).toEqual({ filed: false, reason: 'nothing_substantive' });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('"hola, soy Ana" → nothing_substantive', async () => {
    const { tickets, floor } = setup();
    expect(data(await floor({ callerLines: ['Hola, soy Ana'], callerName: 'Ana', language: 'es' }))).toEqual({
      filed: false,
      reason: 'nothing_substantive',
    });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('"I need a fade Friday" → filed, details hold that line', async () => {
    const { tickets, floor } = setup();
    const result = await floor({ callerLines: ['Hi, this is Luis', 'I need a fade Friday'], callerName: 'Luis' });
    const out = data(result);
    expect(out).toMatchObject({ filed: true, reason: 'filed' });
    expect(typeof out.ticketId).toBe('string');
    expect(typeof out.ticketNumber).toBe('number');

    expect(tickets.state.tickets).toHaveLength(1);
    const ticket = tickets.state.tickets[0];
    expect(ticket).toMatchObject({
      id: out.ticketId,
      tenantId: TENANT,
      kind: 'message',
      urgency: 'normal',
      priority: 'medium',
      subject: FLOOR_SUBJECT,
      contactName: 'Luis',
      contactPhone: '',
      sourceCallRef: CALL,
    });
    expect(ticket.description).toBe('Hi, this is Luis\nI need a fade Friday');

    // Same ticket.opened outbox row + effect as the normal open path.
    expect(tickets.state.outbox).toHaveLength(1);
    expect(tickets.state.outbox[0]).toMatchObject({
      tenantId: TENANT,
      eventType: 'ticket.opened',
      payload: { ticketId: out.ticketId, kind: 'message', callId: CALL, floor: true, idempotencyKey: `call-${CALL}-floor` },
    });
    expect(result.ok && result.effects?.map((e) => e.type)).toEqual(['ticket.opened']);
    expect(tickets.state.activities.find((a) => a.type === 'created')?.metadata).toMatchObject({ floor: true, actor: 'system' });
  });

  it('Spanish "quiero una cita el viernes" → filed with the English subject', async () => {
    const { tickets, floor } = setup();
    expect(data(await floor({ callerLines: ['quiero una cita el viernes'], language: 'es' }))).toMatchObject({
      filed: true,
      reason: 'filed',
    });
    expect(tickets.state.tickets[0]).toMatchObject({ subject: FLOOR_SUBJECT, description: 'quiero una cita el viernes' });
  });

  it('re-run with the same callId → exactly one ticket (stored result replayed)', async () => {
    const { store, tickets, floor } = setup();
    const input = { callerLines: ['I need a fade Friday'] };
    const first = await floor(input);
    const second = await floor(input);
    expect(second).toEqual(first);
    expect(tickets.state.tickets).toHaveLength(1);
    expect(tickets.state.outbox).toHaveLength(1);

    // Even with the idempotency entry gone, the already_filed check holds the line.
    store.idempotency.clear();
    expect(data(await floor(input))).toEqual({ filed: false, reason: 'already_filed' });
    expect(tickets.state.tickets).toHaveLength(1);
  });

  it('an existing ticket for the callId → already_filed', async () => {
    const { tickets, floor } = setup();
    await tickets.repo({ query: async () => ({ rows: [] }) }, TENANT).insert({
      kind: 'callback',
      subject: 'call me back',
      description: '',
      contactName: '',
      contactPhone: '555-010-0142',
      urgency: 'normal',
      priority: 'medium',
      source: 'ai_agent',
      intake: {},
      callbackDueAt: null,
      callRef: CALL,
      createdByUserId: null,
      now: NOW,
    });
    expect(data(await floor({ callerLines: ['I need a fade Friday'] }))).toEqual({ filed: false, reason: 'already_filed' });
    expect(tickets.state.tickets).toHaveLength(1);
    expect(tickets.state.outbox).toHaveLength(0);
  });

  it('a booking made on the call → already_filed', async () => {
    const { tickets, floor } = setup();
    tickets.state.bookedCalls.add(`${TENANT}\0${CALL}`);
    expect(data(await floor({ callerLines: ['I need a fade Friday'] }))).toEqual({ filed: false, reason: 'already_filed' });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('a booking made on the call, found through its CallSid → already_filed', async () => {
    const { tickets, floor } = setup();
    tickets.state.callSessions.set(`${TENANT}\0CA-x`, 'sess-x');
    tickets.state.bookedCalls.add(`${TENANT}\0sess-x`);
    const ctx = systemCtx('CA-x', { callId: undefined });
    expect(data(await floor({ callId: 'CA-x', callerLines: ['I need a fade Friday'] }, ctx))).toEqual({
      filed: false,
      reason: 'already_filed',
    });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('a non-system actor → FORBIDDEN', async () => {
    const { tickets, floor } = setup();
    const input = { callerLines: ['I need a fade Friday'] };
    expectFail(await floor(input, systemCtx(CALL, { actor: { type: 'agent', id: 'agent-1' } })), 'FORBIDDEN');
    expectFail(
      await floor(input, systemCtx(CALL, { actor: { type: 'user', id: 'owner-1', role: 'tenant_owner' } })),
      'FORBIDDEN',
    );
    expectFail(
      await floor(input, systemCtx(CALL, { actor: { type: 'mcp', id: 'mcp-1', scopes: ['qvo:admin', 'qvo:read'] } })),
      'FORBIDDEN',
    );
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('a card-like number in a line is redacted in the ticket details', async () => {
    const { tickets, floor } = setup();
    await floor({ callerLines: ['I want to pay with my card 4111 1111 1111 1111', 'or call me at 555-010-0142'] });
    const { description } = tickets.state.tickets[0];
    expect(description).not.toMatch(/4111/);
    expect(description).toContain(NUMBER_MASK);
    expect(description).not.toContain('010-0142');
    expect(description).toContain('***0142');
  });

  it('"hi, this is Luis, my number is 555 201 3344" → filed, the number masked in the details', async () => {
    const { store, tickets, floor } = setup();
    const out = data(await floor({ callerLines: ['hi, this is Luis, my number is 555 201 3344'], callerName: 'Luis' }));
    expect(out.reason).toBe('filed');
    const { description } = tickets.state.tickets[0];
    expect(description).toBe('hi, this is Luis, my number is ***3344');
    for (const audit of store.audits) {
      const stored = JSON.stringify(audit.inputRedacted);
      expect(stored).not.toMatch(/\d{13,19}/);
      expect(stored.replace(/[\s,.-]/g, '')).not.toContain('5552013344');
      expect(stored).not.toContain('555 201');
      expect(stored).toContain('***3344');
    }
  });

  it('name plus a bare callback number → filed, judged on the raw lines', async () => {
    const { store, tickets, floor } = setup();
    // Masked, the number would be one token ("3344") and the call would read as name only.
    const out = data(await floor({ callerLines: ['Hi, this is Luis', '555 201 3344'], callerName: 'Luis' }));
    expect(out.reason).toBe('filed');
    expect(tickets.state.tickets[0].description).toBe('Hi, this is Luis\n***3344');
    const stored = JSON.stringify(store.audits[0].inputRedacted);
    expect(stored).not.toContain('555 201');
    expect(stored).toContain('"substantive":true');
  });

  it('a caller-supplied substantive flag → VALIDATION_FAILED', async () => {
    const { tickets, floor } = setup();
    expectFail(await floor({ callerLines: ['Hi, this is Luis'], callerName: 'Luis', substantive: true }), 'VALIDATION_FAILED');
    expectFail(await floor({ callerLines: ['I need a fade Friday'], substantive: false }), 'VALIDATION_FAILED');
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('writes the ticket in the calling tenant only', async () => {
    const { tickets, floor } = setup();
    // The other tenant already filed something for the same call id; it must not count here.
    tickets.state.bookedCalls.add(`${OTHER}\0${CALL}`);
    const out = data(await floor({ callerLines: ['I need a fade Friday'] }));
    expect(out.reason).toBe('filed');
    expect(tickets.state.tickets.map((t) => t.tenantId)).toEqual([TENANT]);
    expect(tickets.state.outbox.map((o) => o.tenantId)).toEqual([TENANT]);
    expect(await tickets.repo({ query: async () => ({ rows: [] }) }, OTHER).get(out.ticketId!)).toBeNull();

    // The other tenant's floor for the same call id is judged on its own rows.
    const otherCtx = systemCtx(CALL, { tenantId: OTHER });
    expect(data(await floor({ callerLines: ['I need a fade Friday'] }, otherCtx))).toEqual({
      filed: false,
      reason: 'already_filed',
    });
  });

  it('takes the caller phone from the call record, never from input', async () => {
    const decrypted: string[] = [];
    const { tickets, floor } = setup(async (tenantId, stored) => {
      decrypted.push(`${tenantId}:${stored}`);
      return stored === 'enc:v1:abc' ? '+15550100142' : null;
    });
    tickets.state.callerNumbers.set(`${TENANT}\0${CALL}`, 'enc:v1:abc');
    expectFail(await floor({ callerLines: ['I need a fade Friday'], callerPhone: '+15559999999' }), 'VALIDATION_FAILED');
    data(await floor({ callerLines: ['I need a fade Friday'] }));
    expect(decrypted).toEqual([`${TENANT}:enc:v1:abc`]);
    expect(tickets.state.tickets[0].contactPhone).toBe('+15550100142');
  });

  it('files without a phone when the call record has none or it cannot be read', async () => {
    const { tickets, floor } = setup(async () => {
      throw new Error('no key');
    });
    tickets.state.callerNumbers.set(`${TENANT}\0CA-2`, 'garbled-ciphertext');
    data(await floor({ callId: 'CA-2', callerLines: ['I need a fade Friday'] }));
    data(await floor({ callId: 'CA-3', callerLines: ['I need a fade Friday'] }));
    expect(tickets.state.tickets.map((t) => t.contactPhone)).toEqual(['', '']);
  });

  it('uses a legacy plain-text caller number without decrypting', async () => {
    const { tickets, floor } = setup(async () => {
      throw new Error('must not decrypt');
    });
    tickets.state.callerNumbers.set(`${TENANT}\0${CALL}`, '+1 555 010 0142');
    data(await floor({ callerLines: ['I need a fade Friday'] }));
    expect(tickets.state.tickets[0].contactPhone).toBe('+1 555 010 0142');
  });

  it('requires the call-<callId>-floor idempotency key and a matching context call', async () => {
    const { tickets, floor } = setup();
    const input = { callerLines: ['I need a fade Friday'] };
    expectFail(await floor(input, systemCtx(CALL, { idempotencyKey: 'something-else' })), 'VALIDATION_FAILED', 'idempotencyKey');
    expectFail(await floor(input, systemCtx(CALL, { callId: 'CA-other' })), 'VALIDATION_FAILED', 'callId');
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('caps input at 50 lines of 500 characters', async () => {
    const { floor } = setup();
    expectFail(await floor({ callerLines: Array.from({ length: 51 }, () => 'I need a fade') }), 'VALIDATION_FAILED', 'callerLines');
    expectFail(await floor({ callerLines: ['x'.repeat(501)] }), 'VALIDATION_FAILED', 'callerLines.0');
  });

  it('applies the tenant callback SLA like a normal message ticket', async () => {
    const { tickets, floor } = setup();
    tickets.state.slaMinutes.set(TENANT, { medium: 90 });
    data(await floor({ callerLines: ['I need a fade Friday'] }));
    expect(tickets.state.tickets[0].callbackDueAt?.toISOString()).toBe('2026-10-17T16:30:00.000Z');
    expect(tickets.state.slaInstances).toHaveLength(1);
  });
});

describe('redactCallerText', () => {
  it('removes card-shaped digit runs and masks phones, leaving words and short numbers', () => {
    expect(redactCallerText('card 4111111111111111 exp 12/27')).toBe(`card ${NUMBER_MASK} exp 12/27`);
    expect(redactCallerText('4111-1111-1111-1111')).toBe(NUMBER_MASK);
    expect(redactCallerText('call 555.010.0142')).toBe('call ***0142');
    expect(redactCallerText('a fade Friday at 9, two of us')).toBe('a fade Friday at 9, two of us');
  });

  it('removes a space-grouped card number', () => {
    expect(redactCallerText('my card is 4111 1111 1111 1111 ok')).toBe(`my card is ${NUMBER_MASK} ok`);
  });

  it('removes a comma-grouped card number (ASR style)', () => {
    expect(redactCallerText('it is 4111, 1111, 1111, 1111.')).toBe(`it is ${NUMBER_MASK}.`);
  });

  it('removes a dot-grouped card number', () => {
    expect(redactCallerText('4111.1111.1111.1111 thanks')).toBe(`${NUMBER_MASK} thanks`);
  });

  it('removes a dash-grouped card number with spaced dashes', () => {
    expect(redactCallerText('4111 - 1111 - 1111 - 1111')).toBe(NUMBER_MASK);
  });

  it('removes a card number split across two lines and keeps the line break', () => {
    expect(redactCallerText('my card is 4111 1111\n1111 1111 thanks')).toBe(`my card is ${NUMBER_MASK}\n thanks`);
  });

  it('removes an SSN-shaped number', () => {
    expect(redactCallerText('my social is 123-45-6789.')).toBe(`my social is ${SSN_MASK}.`);
  });

  it('is unchanged when run on its own output', () => {
    const once = redactCallerText('card 4111 1111 1111 1111, ssn 123-45-6789, call 555-010-0142');
    expect(once).toBe(`card ${NUMBER_MASK}, ssn ${SSN_MASK}, call ***0142`);
    expect(redactCallerText(once)).toBe(once);
  });
});

describe('redactCallerLines', () => {
  it('catches a card split across two lines and keeps the line count', () => {
    expect(redactCallerLines(['my card is 4111 1111', '1111 1111 thanks'])).toEqual([`my card is ${NUMBER_MASK}`, ' thanks']);
    expect(redactCallerLines([])).toEqual([]);
  });

  it('labels two adjacent phone numbers as [number removed], not as a card', () => {
    expect(NUMBER_MASK).toBe('[number removed]');
    expect(redactCallerLines(['My number is 305 555 0142', '305 555 0142'])).toEqual([
      `My number is ${NUMBER_MASK}`,
      ' 0142',
    ]);
    expect(redactCallerText('305 555 0142, 305 555 0142')).toBe(`${NUMBER_MASK} 0142`);
  });
});

describe('tickets.file_floor audit row', () => {
  it('holds no 13–19-digit run when a line carries a card number', async () => {
    const { store, floor } = setup();
    const lines = ['I want to pay with my card 4111 1111 1111 1111', 'the rest is 4111', '1111 1111 1111 and 4111.1111.1111.1111'];
    // A filed run, a replay of the same input, and a reuse of the key with other lines: each writes an audit row.
    data(await floor({ callerLines: lines }));
    data(await floor({ callerLines: lines }));
    expectFail(await floor({ callerLines: [...lines, 'also 5500 0000 0000 0004'] }), 'IDEMPOTENCY_KEY_REUSED');
    expect(store.audits.map((a) => a.resultCode)).toEqual(['ok', 'ok', 'IDEMPOTENCY_KEY_REUSED']);
    const digitsOnly = (text: string) => text.replace(/[\s,.-]/g, '');
    for (const audit of store.audits) {
      const stored = JSON.stringify(audit.inputRedacted);
      expect(stored).not.toMatch(/\d{13,19}/);
      expect(digitsOnly(stored)).not.toMatch(/\d{13,19}/);
      expect(stored).not.toContain('4111');
      expect(stored).not.toContain('5500');
    }
    expect(JSON.stringify(store.audits[0].inputRedacted)).toContain(NUMBER_MASK);
  });
});
