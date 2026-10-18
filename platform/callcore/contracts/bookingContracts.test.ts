// RT-06: booking.find@1 / booking.reschedule@1 / booking.cancel@1 on the
// RT-01 format, validated (rules 1–6) against the real action registry, plus
// the additive pieces the read contract needs (action, array sayBack paths,
// requiredWhen, verifiedBy).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ACTION_ERROR_CODES, ACTION_REGISTRY } from '../../actions';
import {
  BOOKING_BOOK_V1,
  BOOKING_CANCEL_V1,
  BOOKING_FIND_V1,
  BOOKING_RESCHEDULE_V1,
  CONTRACTS,
  getContract,
  nextMissingSlot,
  TERMINAL_STEPS,
  type ToolContract,
} from './index';
import { schemaHasPath, validateContract, validateContracts, type ContractActionInfo } from './validate';

const BOOKING_CONTRACTS = [BOOKING_FIND_V1, BOOKING_RESCHEDULE_V1, BOOKING_CANCEL_V1];

describe('booking.find@1 / booking.reschedule@1 / booking.cancel@1', () => {
  it('are registered and every contract passes rules 1–6 against the real ACTION_REGISTRY', () => {
    expect(CONTRACTS.slice(0, 4)).toEqual([BOOKING_BOOK_V1, BOOKING_FIND_V1, BOOKING_RESCHEDULE_V1, BOOKING_CANCEL_V1]);
    for (const contract of CONTRACTS) {
      expect(validateContract(contract, ACTION_REGISTRY, CONTRACTS, ACTION_ERROR_CODES)).toEqual({ ok: true, issues: [] });
    }
    expect(validateContracts(CONTRACTS, ACTION_REGISTRY, ACTION_ERROR_CODES)).toEqual({ ok: true, issues: [] });
  });

  it('getContract resolves each by id@version and bare id', () => {
    for (const contract of BOOKING_CONTRACTS) {
      expect(getContract(`${contract.id}@1`)).toBe(contract);
      expect(getContract(contract.id)).toBe(contract);
    }
  });

  it('all three need a verified identity (caller-ID candidate + first name) and never voice refs', () => {
    for (const contract of BOOKING_CONTRACTS) {
      expect(contract.identity).toBe('verified');
      expect(contract.voiceRefs).toBe(false);
      expect(contract.outbound).toBe('none');
      expect(contract.ceilings.maxAsksPerSlot).toBe(1);
      for (const chain of Object.values(contract.onFailure)) {
        expect(TERMINAL_STEPS.has(chain[chain.length - 1].step)).toBe(true);
      }
      expect(contract.slots.every((s) => s.defaultAsk.en && s.defaultAsk.es)).toBe(true);
    }
  });

  it('booking.find@1 is a read of scheduling.find_bookings with slots in ask order', () => {
    expect(BOOKING_FIND_V1).toMatchObject({ intents: ['find'], sideEffect: 'read', action: 'scheduling.find_bookings', idempotency: 'none' });
    expect(BOOKING_FIND_V1.confirm).toBeUndefined();
    expect(BOOKING_FIND_V1.slots.map((s) => [s.name, s.inputPath, s.askId, s.required, s.heldFrom ?? null, s.requiredWhen ?? null])).toEqual([
      ['phone', 'phone', 'ask.bookingPhone', true, 'callerPhone', null],
      ['name', 'name', 'ask.bookingName', true, null, null],
      ['date', 'date', 'ask.bookingDate', false, null, 'callerIdMismatch'],
      ['time', 'time', 'ask.bookingTime', false, null, 'callerIdMismatch'],
    ]);
    // Only server-worded lines are voiced; ids and refs never are.
    expect(BOOKING_FIND_V1.sayBack).toEqual(['bookings.spoken', 'callerSafeMessage']);
    expect(BOOKING_FIND_V1.sayBack.join(' ')).not.toMatch(/Id\b|ref|token/i);
  });

  it('booking.find@1: the name is the next ask once the phone is in', () => {
    expect(nextMissingSlot(BOOKING_FIND_V1, { phone: '+15555550142' })?.askId).toBe('ask.bookingName');
    expect(nextMissingSlot(BOOKING_FIND_V1, { phone: '+15555550142', name: 'Dana' })).toBeNull();
  });

  it('booking.reschedule@1 and booking.cancel@1 confirm through the real prepare/commit actions', () => {
    expect(BOOKING_RESCHEDULE_V1.confirm).toMatchObject({ prepare: 'scheduling.reschedule.prepare', commit: 'scheduling.reschedule.commit', explicitYes: true });
    expect(BOOKING_CANCEL_V1.confirm).toMatchObject({ prepare: 'scheduling.cancel.prepare', commit: 'scheduling.cancel.commit', explicitYes: true });
    expect(BOOKING_RESCHEDULE_V1.slots.map((s) => [s.name, s.inputPath, s.askId, s.verifiedBy ?? null])).toEqual([
      ['booking', 'bookingId', 'ask.bookingToChange', 'booking.find'],
      ['newTime', 'newStart', 'ask.newTime', null],
    ]);
    expect(BOOKING_CANCEL_V1.slots.map((s) => [s.name, s.inputPath, s.askId, s.verifiedBy ?? null])).toEqual([
      ['booking', 'bookingId', 'ask.bookingToCancel', 'booking.find'],
    ]);
    for (const contract of [BOOKING_RESCHEDULE_V1, BOOKING_CANCEL_V1]) {
      expect(contract).toMatchObject({ sideEffect: 'write', idempotency: 'proposalToken', sayBack: ['readback'] });
    }
    expect(BOOKING_RESCHEDULE_V1.onFailure.CONFLICT.map((s) => s.step)).toEqual(['offer_alternatives', 'ask_again', 'message_ticket']);
  });
});

describe('additive validator pieces (RT-06)', () => {
  const readInput = z.object({ phone: z.string(), name: z.string().optional() });
  const readOutput = z.object({ rows: z.array(z.object({ spoken: z.string(), id: z.string() })), note: z.string().optional() });
  const ACTIONS: ContractActionInfo[] = [
    { name: 'fake.read', permissions: { agent: true }, input: readInput, output: readOutput },
    { name: 'fake.ui_read', permissions: { agent: false }, input: readInput, output: readOutput },
  ];

  function readFixture(overrides: Partial<ToolContract> = {}): ToolContract {
    return {
      id: 'fake.find',
      version: 1,
      intents: ['find'],
      slots: [{ name: 'name', inputPath: 'name', required: true, askId: 'ask.name', defaultAsk: { en: 'Name?', es: '¿Nombre?' } }],
      action: 'fake.read',
      sideEffect: 'read',
      outbound: 'none',
      identity: 'verified',
      idempotency: 'none',
      sayBack: ['rows.spoken', 'note'],
      voiceRefs: false,
      onFailure: { default: [{ step: 'message_ticket' }] },
      ceilings: { maxAsksPerSlot: 1 },
      ...overrides,
    };
  }
  const rules = (c: ToolContract, peers: ToolContract[] = [c]) => [...new Set(validateContract(c, ACTIONS, peers).issues.map((i) => i.rule))];

  it('a read contract checks slots against its action input and sayBack against its output (through arrays)', () => {
    expect(validateContract(readFixture(), ACTIONS, [readFixture()])).toEqual({ ok: true, issues: [] });
    expect(rules(readFixture({ sayBack: ['rows.missing'] }))).toEqual([4]);
    expect(rules(readFixture({ slots: [{ name: 'x', inputPath: 'date', required: true, askId: 'ask.x', defaultAsk: { en: 'X?', es: '¿X?' } }] }))).toEqual([6]);
  });

  it('rule 1: a read contract must name an agent-permitted action', () => {
    expect(rules(readFixture({ action: undefined, sayBack: [], slots: [] }))).toEqual([1]);
    expect(rules(readFixture({ action: 'fake.ui_read' }))).toEqual([1]);
    expect(rules(readFixture({ action: 'fake.nope', sayBack: [], slots: [] }))).toEqual([1]);
  });

  it('rule 6: verifiedBy must name a contract whose identity is verified', () => {
    const verifying = readFixture();
    const slot = { name: 'name', inputPath: 'name', required: true, askId: 'ask.name', defaultAsk: { en: 'Name?', es: '¿Nombre?' } };
    const user = readFixture({ id: 'fake.use', slots: [{ ...slot, verifiedBy: 'fake.find' }] });
    expect(rules(user, [verifying, user])).toEqual([]);
    expect(rules(user, [{ ...verifying, identity: 'callerIdCandidate' }, user])).toEqual([6]);
    expect(rules(readFixture({ id: 'fake.use', slots: [{ ...slot, verifiedBy: 'fake.unknown' }] }))).toEqual([6]);
  });

  it('schemaHasPath steps into array elements only', () => {
    expect(schemaHasPath(readOutput, 'rows.spoken')).toBe(true);
    expect(schemaHasPath(readOutput, 'rows')).toBe(true);
    expect(schemaHasPath(readOutput, 'rows.nope')).toBe(false);
    expect(schemaHasPath(readOutput, 'note.length')).toBe(false);
  });
});
