import { describe, expect, it } from 'vitest';
import { createMemoryStore, runAction, type ActionContext, type ActionResult } from '../core';
import { createMemoryTicketsRepo } from './__fixtures__/memoryRepo';
import { createTicketsActions } from './actions';
import {
  NUMBER_MASK,
  FILE_FLOOR,
  FLOOR_MAX_CALL_ID_LENGTH,
  FLOOR_MAX_LINE_LENGTH,
  FLOOR_MAX_LINES,
  FLOOR_MAX_NAME_LENGTH,
  FLOOR_MAX_TOOL_NAME_LENGTH,
  FLOOR_SUBJECT,
  SSN_MASK,
  SYSTEM_END_SUBJECT,
  TIME_LIMIT_SUBJECT,
  floorAuditRawInput,
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
  /** Sends `input` exactly as given (no callId added), for shapes that aren't an object. */
  const floorRaw = (input: unknown) => runAction(FILE_FLOOR, systemCtx(), input, deps);
  return { store, tickets, floor, floorRaw };
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

  it.each([['Hi, this is Luis, 5552013344'], ['Hi, this is Luis +15552013344']])(
    'name plus a contiguous callback number (%s) → filed, the number masked in details and audit',
    async (line) => {
      const { store, tickets, floor } = setup();
      const out = data(await floor({ callerLines: [line], callerName: 'Luis' }));
      expect(out.reason).toBe('filed');
      const { description } = tickets.state.tickets[0];
      expect(description).not.toContain('5552013344');
      expect(description).toContain('***3344');
      for (const audit of store.audits) {
        const stored = JSON.stringify(audit.inputRedacted);
        expect(stored).not.toContain('5552013344');
        expect(stored).toContain('***3344');
      }
    },
  );

  it.each([
    ['a card number', '4111 1111 1111 1111', NUMBER_MASK, /4111|1111/],
    ['an SSN', '123-45-6789', SSN_MASK, /123-45|6789/],
    ['a space-separated SSN', '123 45 6789', SSN_MASK, /123 45|6789/],
    ['a contiguous SSN', '123456789', SSN_MASK, /123456789|6789/],
  ])('a callerName holding %s → filed, the stored contact name and the audit row hold no digits', async (_label, name, mask, digits) => {
    const { store, tickets, floor } = setup();
    const out = data(await floor({ callerLines: ['I need a fade Friday'], callerName: name }));
    expect(out).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets).toHaveLength(1);
    expect(tickets.state.tickets[0].contactName).toBe(mask);
    expect(store.audits.map((a) => a.resultCode)).toEqual(['ok']);
    const stored = JSON.stringify(store.audits[0].inputRedacted);
    expect(stored).not.toMatch(digits);
    expect(stored).toContain(`"callerName":"${mask}"`);
  });

  it.each([['123 45 6789'], ['123456789']])(
    'name plus an SSN (%s) → filed, judged on the raw lines, the SSN masked in details and audit',
    async (ssn) => {
      const { store, tickets, floor } = setup();
      const out = data(await floor({ callerLines: ['Hi, this is Luis', ssn], callerName: 'Luis' }));
      expect(out.reason).toBe('filed');
      expect(tickets.state.tickets[0].description).toBe(`Hi, this is Luis\n${SSN_MASK}`);
      const stored = JSON.stringify(store.audits[0].inputRedacted);
      expect(stored).not.toMatch(/6789/);
      expect(stored).toContain('"substantive":true');
    },
  );

  it.each([['Luis Garcia'], ['María José']])('a normal callerName (%s) is stored and audited unchanged', async (name) => {
    const { store, tickets, floor } = setup();
    data(await floor({ callerLines: ['I need a fade Friday'], callerName: name }));
    expect(tickets.state.tickets[0].contactName).toBe(name);
    expect((store.audits[0].inputRedacted as { callerName?: string }).callerName).toBe(name);
  });

  it('the name is dropped from the lines using the raw callerName, before it is redacted', async () => {
    const { tickets, floor } = setup();
    // Judged on the redacted name ("[number removed]"), the four digit groups would be content words.
    expect(data(await floor({ callerLines: ['4111 1111 1111 1111'], callerName: '4111 1111 1111 1111' }))).toEqual({
      filed: false,
      reason: 'nothing_substantive',
    });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('name plus a short number ("Luis 42") → nothing_substantive', async () => {
    const { tickets, floor } = setup();
    expect(data(await floor({ callerLines: ['Luis 42'], callerName: 'Luis' }))).toEqual({
      filed: false,
      reason: 'nothing_substantive',
    });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('a multi-word self-introduction without callerName → nothing_substantive (EN and ES)', async () => {
    const { tickets, floor } = setup();
    expect(data(await floor({ callerLines: ['Hi, this is Luis Garcia'] }))).toEqual({ filed: false, reason: 'nothing_substantive' });
    expect(data(await floor({ callId: 'CA-es', callerLines: ['Hola, habla María José López'] }, systemCtx('CA-es')))).toEqual({
      filed: false,
      reason: 'nothing_substantive',
    });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('"This is Luis, cancel Friday" with callerName "Luis" → filed (a name never crosses a comma)', async () => {
    const { tickets, floor } = setup();
    const out = data(await floor({ callerLines: ['This is Luis, cancel Friday'], callerName: 'Luis' }));
    expect(out).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets).toHaveLength(1);
  });

  it('a booking stored under the CallSid, floor called with the session id → already_filed', async () => {
    const { tickets, floor } = setup();
    tickets.state.callSessions.set(`${TENANT}\0CA-y`, 'sess-y');
    tickets.state.bookedCalls.add(`${TENANT}\0CA-y`);
    const ctx = systemCtx('sess-y', { callId: undefined });
    expect(data(await floor({ callId: 'sess-y', callerLines: ['I need a fade Friday'] }, ctx))).toEqual({
      filed: false,
      reason: 'already_filed',
    });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('a ticket stored with only source_call_ref = the CallSid, floor called with the session id → already_filed', async () => {
    const { tickets, floor } = setup();
    tickets.state.callSessions.set(`${TENANT}\0CA-z`, 'sess-z');
    await tickets.repo({ query: async () => ({ rows: [] }) }, TENANT).insert({
      kind: 'callback',
      subject: 'call me back',
      description: '',
      contactName: '',
      contactPhone: '',
      urgency: 'normal',
      priority: 'medium',
      source: 'ai_agent',
      intake: {},
      callbackDueAt: null,
      callRef: 'CA-z',
      createdByUserId: null,
      now: NOW,
    });
    expect(tickets.state.tickets[0]).toMatchObject({ callId: null, sourceCallRef: 'CA-z' });
    const ctx = systemCtx('sess-z', { callId: undefined });
    expect(data(await floor({ callId: 'sess-z', callerLines: ['I need a fade Friday'] }, ctx))).toEqual({
      filed: false,
      reason: 'already_filed',
    });
    expect(tickets.state.tickets).toHaveLength(1);
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

  it.each([['123-45-6789'], ['123 45 6789'], ['123.45.6789'], ['123456789']])('removes an SSN-shaped number (%s)', (ssn) => {
    expect(redactCallerText(ssn)).toBe(SSN_MASK);
    expect(redactCallerText(`my social is ${ssn}.`)).toBe(`my social is ${SSN_MASK}.`);
  });

  it.each([['555 010 0142'], ['5550100142'], ['+15550100142']])('masks a phone number (%s) to its last 4, not as an SSN', (phone) => {
    expect(redactCallerText(phone)).toBe('***0142');
    expect(redactCallerText(`call me at ${phone} please`)).toBe('call me at ***0142 please');
  });

  it('is unchanged when run on its own output', () => {
    const once = redactCallerText(
      'card 4111 1111 1111 1111, ssn 123-45-6789, ssn 123 45 6789, ssn 123456789, call 555-010-0142, call 5550100142',
    );
    expect(once).toBe(`card ${NUMBER_MASK}, ssn ${SSN_MASK}, ssn ${SSN_MASK}, ssn ${SSN_MASK}, call ***0142, call ***0142`);
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

  const cardAndSsns = 'card 4111 1111 1111 1111, ssn 123-45-6789, ssn 123 45 6789, ssn 123456789';
  it.each([
    ['51 lines', Array.from({ length: 51 }, (_, i) => (i === 7 ? cardAndSsns : 'I need a fade'))],
    ['one line over 500 chars', [`${cardAndSsns} ${'x'.repeat(500)}`]],
  ])('an oversized payload (%s) → VALIDATION_FAILED, the audit row holds no card or SSN and is capped', async (_label, lines) => {
    const { store, floor } = setup();
    expectFail(await floor({ callerLines: lines }), 'VALIDATION_FAILED');
    expect(store.audits.map((a) => a.resultCode)).toEqual(['VALIDATION_FAILED']);
    const audited = store.audits[0].inputRedacted as { callId: string; callerLines: string[] };
    const stored = JSON.stringify(audited);
    expect(stored).not.toContain('4111');
    expect(stored.replace(/[\s,.-]/g, '')).not.toMatch(/\d{13,19}/);
    expect(stored).not.toMatch(/123|6789/);
    expect(stored).toContain(NUMBER_MASK);
    expect(stored).toContain(SSN_MASK);
    expect(audited.callId).toBe(CALL);
    expect(audited.callerLines.length).toBeLessThanOrEqual(FLOOR_MAX_LINES);
    for (const line of audited.callerLines) expect(line.length).toBeLessThanOrEqual(FLOOR_MAX_LINE_LENGTH);
  });

  it('a non-string line → VALIDATION_FAILED, the audit row keeps the redacted string lines and drops the rest', async () => {
    const { store, floor } = setup();
    expectFail(await floor({ callerLines: ['my card is 4111 1111 1111 1111', 42, { x: 1 }] }), 'VALIDATION_FAILED');
    expect(store.audits[0].inputRedacted).toEqual({ callId: CALL, callerLines: [`my card is ${NUMBER_MASK}`] });
  });

  // Capping first would cut these cards to 8 or 12 digits, below CARD_LIKE's 13, and store them unmasked.
  it.each([
    ['a card across the 500-char cut', [`${'x'.repeat(490)} 4111 1111 1111 1111`]],
    [
      'a card split across lines 50 and 51',
      Array.from({ length: 51 }, (_, i) => (i === 49 ? 'card 4111 1111' : i === 50 ? '1111 1111' : 'I need a fade')),
    ],
  ])('%s → VALIDATION_FAILED, redacted before the cap so no 4+ digits of it survive', async (_label, lines) => {
    const { store, floor } = setup();
    expectFail(await floor({ callerLines: lines }), 'VALIDATION_FAILED');
    const audited = store.audits[0].inputRedacted as { callerLines: string[] };
    expect(audited.callerLines.join('\n')).not.toMatch(/\d{4}/);
    expect(audited.callerLines.length).toBeLessThanOrEqual(FLOOR_MAX_LINES);
    for (const line of audited.callerLines) expect(line.length).toBeLessThanOrEqual(FLOOR_MAX_LINE_LENGTH);
  });

  it('an unknown key holding a card → VALIDATION_FAILED, the audit row drops the key', async () => {
    const { store, floor } = setup();
    expectFail(await floor({ callerLines: [], extra: '4111 1111 1111 1111' }), 'VALIDATION_FAILED');
    expect(store.audits[0].inputRedacted).toEqual({ callId: CALL, callerLines: [] });
  });

  it.each([
    ['a string', '4111 1111 1111 1111'],
    ['an array', ['4111 1111 1111 1111']],
  ])('%s as the whole input → VALIDATION_FAILED, the audit row is {}', async (_label, input) => {
    const { store, floorRaw } = setup();
    expectFail(await floorRaw(input), 'VALIDATION_FAILED');
    expect(store.audits[0].inputRedacted).toEqual({});
  });

  it('callerLines sent as one string holding a card → VALIDATION_FAILED, audited as one redacted line', async () => {
    const { store, floor } = setup();
    expectFail(await floor({ callerLines: 'my card is 4111 1111 1111 1111' }), 'VALIDATION_FAILED');
    expect(store.audits[0].inputRedacted).toEqual({ callId: CALL, callerLines: [`my card is ${NUMBER_MASK}`] });
  });

  it.each([['123-45-6789'], ['123 45 6789'], ['123456789']])(
    'an over-long callerName holding an SSN (%s) → VALIDATION_FAILED, audited redacted, then capped',
    async (ssn) => {
      const { store, floor } = setup();
      // The SSN straddles the 255-char cut, so capping first would leave "123" unmasked.
      const callerName = `${'y'.repeat(250)} ${ssn} ${'z'.repeat(20)}`;
      expectFail(await floor({ callerLines: ['I need a fade'], callerName }), 'VALIDATION_FAILED');
      const audited = store.audits[0].inputRedacted as { callerName: string };
      expect(audited.callerName).toBe(`${'y'.repeat(250)} ${SSN_MASK}`.slice(0, FLOOR_MAX_NAME_LENGTH));
      expect(audited.callerName).not.toMatch(/\d/);
    },
  );
});

describe('floorAuditRawInput', () => {
  it('keeps only the known keys, each in its allowed shape', () => {
    expect(
      floorAuditRawInput({
        callId: 'CA-1',
        extra: '4111 1111 1111 1111',
        callerLines: ['ssn 123-45-6789', 'ssn 123 45 6789', 'ssn 123456789'],
        callerName: 'Luis Garcia',
        language: 'es',
      }),
    ).toEqual({
      callId: 'CA-1',
      callerLines: [`ssn ${SSN_MASK}`, `ssn ${SSN_MASK}`, `ssn ${SSN_MASK}`],
      callerName: 'Luis Garcia',
      language: 'es',
    });
    expect(floorAuditRawInput({ callId: 'c'.repeat(200) })).toEqual({ callId: 'c'.repeat(FLOOR_MAX_CALL_ID_LENGTH) });
    expect(floorAuditRawInput({ callId: 42, callerLines: { 0: 'x' }, callerName: ['Luis'], language: 'fr' })).toEqual({});
    expect(floorAuditRawInput({ callerLines: 'card 4111 1111 1111 1111' })).toEqual({ callerLines: [`card ${NUMBER_MASK}`] });
  });

  it.each([
    ['a string', '4111 1111 1111 1111'],
    ['an array', ['4111 1111 1111 1111']],
    ['a number', 4111111111111111],
    ['null', null],
    ['undefined', undefined],
  ])('returns {} for %s', (_label, raw) => {
    expect(floorAuditRawInput(raw)).toEqual({});
  });

  it('keeps a known end reason, answered, and the tool names cut to size', () => {
    expect(
      floorAuditRawInput({
        endReason: 'max_duration',
        answered: true,
        tools: [{ name: 'scheduling.list_staff', ok: true }, { name: 42 }, { name: 'x'.repeat(200), ok: 'yes' }],
      }),
    ).toEqual({
      endReason: 'max_duration',
      answered: true,
      tools: [
        { name: 'scheduling.list_staff', ok: true },
        { name: 'x'.repeat(FLOOR_MAX_TOOL_NAME_LENGTH), ok: false },
      ],
    });
    expect(floorAuditRawInput({ endReason: 'caller_left', answered: 'yes', tools: 'none' })).toEqual({});
  });
});

describe('tickets.file_floor end reason and answered info calls', () => {
  const INFO_LINES = ['What days does Marco work?', 'And what are your hours on Saturday?'];
  const INFO_TOOLS_RUN = [{ name: 'scheduling.list_staff', ok: true }];
  const INFO_CALL = { callerLines: INFO_LINES, endReason: 'caller_hangup', tools: INFO_TOOLS_RUN, answered: true };

  it('an answered info-only call the caller ends → answered_info, nothing filed', async () => {
    const { tickets, floor } = setup();
    expect(data(await floor(INFO_CALL))).toEqual({ filed: false, reason: 'answered_info' });
    expect(tickets.state.tickets).toHaveLength(0);
    expect(tickets.state.outbox).toHaveLength(0);
  });

  it('an info call answered from known facts (no tools) → answered_info', async () => {
    const { tickets, floor } = setup();
    const input = { callerLines: ['What time do you close today?'], endReason: 'caller_hangup', tools: [], answered: true };
    expect(data(await floor(input))).toEqual({ filed: false, reason: 'answered_info' });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('a caller hang-up mid-booking still files "Caller hung up before finishing"', async () => {
    const { tickets, floor } = setup();
    const out = data(
      await floor({
        callerLines: ['What are your hours Friday?', 'Can I book a fade with Marco at 3?'],
        endReason: 'caller_hangup',
        tools: [{ name: 'scheduling.check_availability', ok: true }],
        answered: true,
      }),
    );
    expect(out).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets[0]).toMatchObject({
      subject: FLOOR_SUBJECT,
      description: 'What are your hours Friday?\nCan I book a fade with Marco at 3?',
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a hold was prepared', { tools: [...INFO_TOOLS_RUN, { name: 'scheduling.book.prepare', ok: true }] }],
    ['an info tool failed', { tools: [{ name: 'scheduling.list_staff', ok: false }] }],
    ['an availability check ran', { tools: [{ name: 'scheduling.check_availability', ok: true }] }],
    ['the agent did not answer the last line', { answered: false }],
    ['answered is not sent', { answered: undefined }],
    ['tools are not sent', { tools: undefined }],
    ['no end reason is sent', { endReason: undefined }],
    ['the call hit the time limit', { endReason: 'max_duration' }],
  ])('an info call where %s → filed', async (_label, override) => {
    const { tickets, floor } = setup();
    const sent = Object.fromEntries(Object.entries({ ...INFO_CALL, ...override }).filter(([, value]) => value !== undefined));
    expect(data(await floor(sent))).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets).toHaveLength(1);
  });

  it.each([
    ['asked for a callback', ['What are your hours?', 'Can someone call me back?']],
    ['asked for a person', ['What are your prices?', 'Let me talk to the owner']],
    ['gave a callback number', ['What are your hours? My number is 5552013344']],
    ['asked for a cita', ['¿Cuál es su horario?', 'Quiero una cita el viernes']],
    ['asked nothing informational', ['My beard trim came out uneven']],
  ])('a caller who %s → filed with FLOOR_SUBJECT', async (_label, callerLines) => {
    const { tickets, floor } = setup();
    expect(data(await floor({ callerLines, endReason: 'caller_hangup', tools: [], answered: true }))).toMatchObject({
      filed: true,
      reason: 'filed',
    });
    expect(tickets.state.tickets[0].subject).toBe(FLOOR_SUBJECT);
  });

  // The review's wording for a callback, availability or booking request; each must file.
  it.each([
    ['Llámenme por favor, ¿dónde están ubicados?'],
    ['¿Me pueden regresar la llamada? ¿Cuál es su horario?'],
    ['¿Tienen disponibilidad el sábado? ¿A qué hora abren?'],
    ['Quisiera un corte el sábado, ¿cuánto cuesta?'],
    ['¿Hacen reservación? ¿Cuánto cuesta el corte?'],
    ['¿Hacen reserva? ¿Cuánto cuesta el corte?'],
    ['Me gustaría un turno, ¿cuánto cuesta?'],
    ['¿Tienen espacio? ¿Cuánto cuesta?'],
    ['Que me devuelvan la llamada, ¿cuál es su horario?'],
    ['Que me regresen, ¿cuál es su horario?'],
    ['Can I get a fade at 3 tomorrow? How much is it?'],
    ["I'd like a haircut Saturday, what time do you open?"],
    ['Is Marco free Saturday at 2?'],
    ['Is Marco free Saturday at 2? What are your prices?'],
    ['Can you put me down for 4? How much is a fade?'],
    ['Can you hold a chair for me? What are your prices?'],
    ['Put me on the waitlist. What are your prices?'],
    ['Can I make an appointment? What are your prices?'],
    ['Is the 5 o clock cancelled? What are your hours?'],
    ['How much to reschedule? What are your prices?'],
    // Round 2: the day sits in an hours / staff-days question and the ask is its own sentence.
    ['Does Marco work Saturday? Can he take me?'],
    ['Does Ana work Friday? Can she do my nails?'],
    ['Does Marco work Saturday? Could he cut my hair?'],
    ['Does Marco work Saturday? Sign me up.'],
    ['¿Marco trabaja el sábado? ¿Me puede atender?'],
    ['¿Abren el sábado? ¿Puedo pasar?'],
    ['¿Abren el sábado? ¿Puedo ir?'],
    ['¿Me llama por favor? ¿Cuál es su horario?'],
  ])('an answered info call where the caller said "%s" → filed', async (line) => {
    const { tickets, floor } = setup();
    expect(data(await floor({ ...INFO_CALL, callerLines: [line] }))).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets[0].subject).toBe(FLOOR_SUBJECT);
  });

  // Round 3: an info question beside a sentence that is not one files, even with no action word.
  it.each([
    ['I left my wallet there. What time do you close?'],
    ['I left my wallet there', 'What time do you close?'],
    ['My beard trim came out uneven. What are your prices?'],
    ['Dejé mi cartera ahí. ¿A qué hora cierran?'],
    ['El corte me quedó disparejo. ¿Cuánto cuesta?'],
  ])('an answered info call with a non-info sentence ("%s") → filed', async (...callerLines) => {
    const { tickets, floor } = setup();
    expect(data(await floor({ ...INFO_CALL, callerLines }))).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets[0].subject).toBe(FLOOR_SUBJECT);
  });

  // Third-person, plural and past forms, and "room" / "space" / "lugar" / "hueco", inside the info clause too.
  it.each([
    ['How much is a color? My daughter wants one.'],
    ['How much is a color my daughter wants one'],
    ['How much is a fade, my son needs one'],
    ['What are your prices? We wanted two cuts.'],
    ['How much is a cut, I wanna come by'],
    ['¿Cuánto cuesta un tinte? Mi hija quiere uno.'],
    ['¿Cuánto cuesta un tinte que mi hija quiere?'],
    ['¿Cuánto cuesta el corte que necesitan mis hijos?'],
    ['¿Cuánto cobran? Queremos dos cortes.'],
    ['¿Hay lugar mañana?'],
    ['¿Dónde están y hay lugar?'],
    ['¿Dónde están y tienen un hueco?'],
    ['Do you have any room tomorrow?'],
    ['Where are you located and is there any room'],
    ['Where are you located and do you have space'],
  ])('an answered info call where someone wants it or asks for room ("%s") → filed', async (line) => {
    const { tickets, floor } = setup();
    expect(data(await floor({ ...INFO_CALL, callerLines: [line] }))).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets[0].subject).toBe(FLOOR_SUBJECT);
  });

  it.each([
    ['a weekday', ['Can Marco take me Saturday? How much is a fade?']],
    ['tomorrow', ['Can Marco take me tomorrow? How much is a fade?']],
    ['mañana', ['¿Me atienden mañana? ¿Cuánto cuesta?']],
    ['a clock time', ['Can Marco take me at 3? What are your prices?']],
    ['a time with p.m.', ['Can Marco take me 4 p.m.? What are your prices?']],
    ['a las', ['¿Me atienden a las cinco? ¿Cuánto cuesta?']],
  ])('a caller who names %s with no action word → filed', async (_label, callerLines) => {
    const { tickets, floor } = setup();
    expect(data(await floor({ ...INFO_CALL, callerLines }))).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets).toHaveLength(1);
  });

  it.each([
    ['staff days', ['Does Marco work Saturdays?']],
    ['hours on a weekday', ['¿A qué hora abren el sábado?']],
    ['English hours on a weekday', ['What are your hours on Saturday?']],
    ['closing time today', ['What time do you close today?']],
    ['staff days, then thanks', ['Does Marco work Saturdays? Thanks!']],
    ['hours asked as "can you tell me"', ['Can you tell me your hours on Saturday?']],
    ['a location after a Spanish introduction', ['Hola, me llamo Ana, ¿dónde están ubicados?']],
  ])('a pure info call about %s → still answered_info', async (_label, callerLines) => {
    const { tickets, floor } = setup();
    expect(data(await floor({ ...INFO_CALL, callerLines }))).toEqual({ filed: false, reason: 'answered_info' });
    expect(tickets.state.tickets).toHaveLength(0);
  });

  it('a callback number read in digit groups → filed', async () => {
    const { tickets, floor } = setup();
    const callerLines = ['My number is 555 201 3344, what are your hours?'];
    expect(data(await floor({ ...INFO_CALL, callerLines }))).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets).toHaveLength(1);
  });

  it('an info call where record_call_outcome ran → filed (its disposition may be a callback)', async () => {
    const { tickets, floor } = setup();
    const tools = [...INFO_TOOLS_RUN, { name: 'record_call_outcome', ok: true }];
    expect(data(await floor({ ...INFO_CALL, tools }))).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets).toHaveLength(1);
  });

  it('a call ended by the time limit → filed with the time-limit subject, and the details say so', async () => {
    const { tickets, floor } = setup();
    const out = data(await floor({ callerLines: ['I need a fade Friday'], endReason: 'max_duration', tools: [], answered: false }));
    expect(out).toMatchObject({ filed: true, reason: 'filed' });
    expect(tickets.state.tickets[0].subject).toBe(TIME_LIMIT_SUBJECT);
    expect(tickets.state.tickets[0].description).toBe(
      'The call reached the time limit and was ended by the system, not by the caller. Please call them back.\n\nI need a fade Friday',
    );
    expect(tickets.state.activities.find((a) => a.type === 'created')?.metadata).toMatchObject({ endReason: 'max_duration' });
  });

  it.each(['agent_ended', 'provider_failure'])('a call the system ended (%s) → filed with the system subject', async (endReason) => {
    const { tickets, floor } = setup();
    expect(data(await floor({ callerLines: ['I need a fade Friday'], endReason }))).toMatchObject({ filed: true });
    expect(tickets.state.tickets[0].subject).toBe(SYSTEM_END_SUBJECT);
    expect(tickets.state.tickets[0].description).toBe(
      'The call was ended by the system, not by the caller. Please call them back.\n\nI need a fade Friday',
    );
  });

  it('a caller hang-up keeps the details as the caller lines only', async () => {
    const { tickets, floor } = setup();
    await floor({ callerLines: ['I need a fade Friday'], endReason: 'caller_hangup' });
    expect(tickets.state.tickets[0]).toMatchObject({ subject: FLOOR_SUBJECT, description: 'I need a fade Friday' });
  });

  it('an unknown end reason or a tool with extra keys → VALIDATION_FAILED, never a skip', async () => {
    const { tickets, floor } = setup();
    expectFail(await floor({ ...INFO_CALL, endReason: 'caller_left' }), 'VALIDATION_FAILED');
    expectFail(await floor({ ...INFO_CALL, tools: [{ name: 'scheduling.list_staff', ok: true, kind: 'read' }] }), 'VALIDATION_FAILED');
    expect(tickets.state.tickets).toHaveLength(0);
  });
});
