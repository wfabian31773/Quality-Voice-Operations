// RT-07: tickets.message@1 on the RT-01 format, validated (rules 1–6) against
// the real action registry with the other four contracts, plus the additive
// validator pieces it needs (afterAsk 'proceed', a prepare-output readback).
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
  TICKETS_MESSAGE_V1,
  type ToolContract,
} from './index';
import { validateContract, validateContracts, type ContractActionInfo } from './validate';

describe('tickets.message@1', () => {
  it('is registered and all five contracts pass rules 1–6 against the real ACTION_REGISTRY', () => {
    expect(CONTRACTS).toEqual([BOOKING_BOOK_V1, BOOKING_FIND_V1, BOOKING_RESCHEDULE_V1, BOOKING_CANCEL_V1, TICKETS_MESSAGE_V1]);
    expect(validateContract(TICKETS_MESSAGE_V1, ACTION_REGISTRY, CONTRACTS, ACTION_ERROR_CODES)).toEqual({ ok: true, issues: [] });
    expect(validateContracts(CONTRACTS, ACTION_REGISTRY, ACTION_ERROR_CODES)).toEqual({ ok: true, issues: [] });
  });

  it('getContract resolves id@version and bare id', () => {
    expect(getContract('tickets.message@1')).toBe(TICKETS_MESSAGE_V1);
    expect(getContract('tickets.message')).toBe(TICKETS_MESSAGE_V1);
  });

  it('serves message and callback through the real prepare/commit pair with an explicit yes', () => {
    expect(TICKETS_MESSAGE_V1).toMatchObject({
      intents: ['message', 'callback'],
      sideEffect: 'write',
      outbound: 'none',
      identity: 'none',
      idempotency: 'proposalToken',
      confirm: { prepare: 'tickets.open.prepare', commit: 'tickets.open.commit', explicitYes: true },
      ceilings: { maxAsksPerSlot: 1 },
    });
  });

  it('declares slots in ask order on the real openPrepareInput paths; the name never blocks', () => {
    expect(
      TICKETS_MESSAGE_V1.slots.map((s) => [s.name, s.inputPath, s.required, s.askId, s.heldFrom ?? null, s.afterAsk ?? null]),
    ).toEqual([
      ['subject', 'subject', true, 'ask.messageSubject', null, null],
      ['customerName', 'customer.name', false, 'ask.messageName', null, null],
      ['callbackNumber', 'customer.phone', true, 'ask.callbackNumber', 'callerPhone', 'proceed'],
    ]);
    expect(TICKETS_MESSAGE_V1.slots.every((s) => s.defaultAsk.en && s.defaultAsk.es)).toBe(true);
  });

  it('voices only the server readback, never refs, and every failure chain ends in an exit', () => {
    expect(TICKETS_MESSAGE_V1.sayBack).toEqual(['readback']);
    expect(TICKETS_MESSAGE_V1.voiceRefs).toBe(false);
    expect(Object.keys(TICKETS_MESSAGE_V1.onFailure)).toEqual(['SLOT_MISSING', 'default']);
    for (const chain of Object.values(TICKETS_MESSAGE_V1.onFailure)) {
      expect(TERMINAL_STEPS.has(chain[chain.length - 1].step)).toBe(true);
    }
  });

  it('the callback number is held from caller ID; without one it is the ask after the subject', () => {
    expect(nextMissingSlot(TICKETS_MESSAGE_V1, {})?.askId).toBe('ask.messageSubject');
    expect(nextMissingSlot(TICKETS_MESSAGE_V1, { subject: 'the order' })?.askId).toBe('ask.callbackNumber');
    expect(nextMissingSlot(TICKETS_MESSAGE_V1, { subject: 'the order' }, { callerPhone: '+15555550142' })).toBeNull();
  });
});

describe('additive validator pieces (RT-07)', () => {
  const ACTIONS: ContractActionInfo[] = [
    {
      name: 'fake.prepare',
      permissions: { agent: true },
      input: z.object({ note: z.string().optional(), phone: z.string().optional() }),
      output: z.object({ readback: z.string() }),
    },
    { name: 'fake.commit', permissions: { agent: true }, input: z.object({}), output: z.object({ ref: z.string() }) },
  ];

  const phoneSlot = { name: 'phone', inputPath: 'phone', askId: 'ask.phone', defaultAsk: { en: 'Phone?', es: '¿Teléfono?' } };

  function fixture(overrides: Partial<ToolContract> = {}): ToolContract {
    return {
      id: 'fake.message',
      version: 1,
      intents: ['message'],
      slots: [
        { name: 'note', inputPath: 'note', required: true, askId: 'ask.note', defaultAsk: { en: 'Note?', es: '¿Nota?' } },
        { ...phoneSlot, required: true, afterAsk: 'proceed' },
      ],
      confirm: { prepare: 'fake.prepare', commit: 'fake.commit', explicitYes: true, maxReadbackCycles: 2 },
      sideEffect: 'write',
      outbound: 'none',
      identity: 'none',
      idempotency: 'proposalToken',
      sayBack: ['readback'],
      voiceRefs: false,
      onFailure: { default: [{ step: 'message_ticket' }] },
      ceilings: { maxAsksPerSlot: 1 },
      ...overrides,
    };
  }
  const rules = (c: ToolContract) => [...new Set(validateContract(c, ACTIONS, [c]).issues.map((i) => i.rule))];

  it('rule 4: a sayBack field may come from the prepare readback; one in neither output still fails', () => {
    expect(validateContract(fixture(), ACTIONS, [fixture()])).toEqual({ ok: true, issues: [] });
    expect(rules(fixture({ sayBack: ['readback', 'ticketNumber'] }))).toEqual([4]);
  });

  it("rule 5: afterAsk 'proceed' only on a required slot", () => {
    const optional = fixture({ slots: [{ ...phoneSlot, required: false, afterAsk: 'proceed' }] });
    expect(validateContract(optional, ACTIONS, [optional]).issues).toEqual([
      { rule: 5, message: "fake.message@1: slot 'phone' proceeds after its ask but is not required" },
    ]);
  });
});
