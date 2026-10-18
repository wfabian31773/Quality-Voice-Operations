import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ACTION_ERROR_CODES, ACTION_REGISTRY } from '../../actions';
import { BOOKING_BOOK_V1, CONTRACTS, getContract } from './index';
import type { ToolContract } from './types';
import { validateContract, validateContracts, type ContractActionInfo, type ContractRule } from './validate';

const prepareInput = z.object({
  item: z.string().optional(),
  contact: z.object({ name: z.string().optional() }).optional(),
});
const commitOutput = z.object({ ref: z.string(), readback: z.string() });

const FAKE_ACTIONS: ContractActionInfo[] = [
  { name: 'fake.prepare', permissions: { agent: true }, input: prepareInput, output: z.object({}) },
  { name: 'fake.commit', permissions: { agent: true }, input: z.object({}), output: commitOutput },
  { name: 'fake.ui_only', permissions: { agent: false }, input: prepareInput, output: commitOutput },
];

function fixture(overrides: Partial<ToolContract> = {}): ToolContract {
  return {
    id: 'fake.flow',
    version: 1,
    intents: ['fake'],
    slots: [
      { name: 'item', inputPath: 'item', required: true, askId: 'ask.item', defaultAsk: { en: 'Which?', es: '¿Cuál?' } },
      { name: 'contactName', inputPath: 'contact.name', required: true, askId: 'ask.contactName', defaultAsk: { en: 'Name?', es: '¿Nombre?' } },
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

function rulesBroken(contract: ToolContract, peers: ToolContract[] = []): ContractRule[] {
  return [...new Set(validateContract(contract, FAKE_ACTIONS, peers).issues.map((i) => i.rule))];
}

describe('validateContract', () => {
  it('accepts a well-formed fixture', () => {
    expect(validateContract(fixture(), FAKE_ACTIONS)).toEqual({ ok: true, issues: [] });
  });

  it('rule 1: named actions must exist and be open to the agent', () => {
    expect(rulesBroken(fixture({ confirm: { prepare: 'fake.missing', commit: 'fake.commit', explicitYes: true, maxReadbackCycles: 2 } }))).toContain(1);
    const uiOnly = fixture({ confirm: { prepare: 'fake.ui_only', commit: 'fake.commit', explicitYes: true, maxReadbackCycles: 2 } });
    expect(rulesBroken(uiOnly)).toEqual([1]);
  });

  it('rule 2: a write contract must have a confirm block', () => {
    expect(rulesBroken(fixture({ confirm: undefined, sayBack: [], slots: [] }))).toEqual([2]);
  });

  it('rule 3: outbound other than none needs an outboundDestination', () => {
    expect(rulesBroken(fixture({ outbound: 'sms' }))).toEqual([3]);
    expect(rulesBroken(fixture({ outbound: 'sms', outboundDestination: 'callerPhone' }))).toEqual([]);
  });

  it('rule 4: every sayBack field must be in the commit output schema', () => {
    expect(rulesBroken(fixture({ sayBack: ['readback', 'totalPrice'] }))).toEqual([4]);
  });

  it('rule 5: every onFailure chain must end in message_ticket or scripted_close', () => {
    expect(rulesBroken(fixture({ onFailure: { CONFLICT: [{ step: 'offer_alternatives' }, { step: 'ask_again', slot: 'item' }] } }))).toEqual([5]);
    expect(rulesBroken(fixture({ onFailure: { CONFLICT: [] } }))).toEqual([5]);
    expect(rulesBroken(fixture({ onFailure: { CONFLICT: [{ step: 'scripted_close' }], default: [{ step: 'message_ticket' }] } }))).toEqual([]);
  });

  it('rule 5: onFailure must have a default chain', () => {
    const empty = validateContract(fixture({ onFailure: {} }), FAKE_ACTIONS);
    expect(empty.issues).toEqual([{ rule: 5, message: 'fake.flow@1: onFailure needs a default chain' }]);
    const noDefault = validateContract(fixture({ onFailure: { CONFLICT: [{ step: 'message_ticket' }] } }), FAKE_ACTIONS);
    expect(noDefault.issues).toEqual([{ rule: 5, message: 'fake.flow@1: onFailure needs a default chain' }]);
  });

  it('rule 5: an ask_again step must name a slot of the contract', () => {
    const unknownSlot = fixture({
      onFailure: { CONFLICT: [{ step: 'ask_again', slot: 'time' }, { step: 'message_ticket' }], default: [{ step: 'message_ticket' }] },
    });
    const result = validateContract(unknownSlot, FAKE_ACTIONS);
    expect(result.issues).toEqual([{ rule: 5, message: expect.stringMatching(/unknown slot 'time'/) }]);
  });

  it('rule 5: onFailure keys must be known error codes or default when the code list is given', () => {
    const typo = fixture({ onFailure: { CONFLCT: [{ step: 'message_ticket' }], default: [{ step: 'message_ticket' }] } });
    const result = validateContract(typo, FAKE_ACTIONS, [], ACTION_ERROR_CODES);
    expect(result.issues).toEqual([{ rule: 5, message: expect.stringMatching(/onFailure\.CONFLCT is not a known error code/) }]);
    const known = fixture({ onFailure: { CONFLICT: [{ step: 'message_ticket' }], default: [{ step: 'message_ticket' }] } });
    expect(validateContract(known, FAKE_ACTIONS, [], ACTION_ERROR_CODES).ok).toBe(true);
  });

  it('rule 6: id@version is unique and slot inputPaths exist in the prepare input', () => {
    const a = fixture();
    expect(rulesBroken(a, [a, fixture()])).toEqual([6]);
    expect(rulesBroken(a, [a, fixture({ version: 2 })])).toEqual([]);
    const badPath = fixture({
      slots: [{ name: 'phone', inputPath: 'contact.phone', required: true, askId: 'ask.phone', defaultAsk: { en: 'Phone?', es: '¿Teléfono?' } }],
    });
    expect(rulesBroken(badPath)).toEqual([6]);
  });

  it('rule 6: the same contract object listed twice is a duplicate', () => {
    const c = fixture();
    const twice = validateContracts([c, c], FAKE_ACTIONS);
    expect(twice.ok).toBe(false);
    expect([...new Set(twice.issues.map((i) => i.rule))]).toEqual([6]);
    expect(validateContracts([c, fixture()], FAKE_ACTIONS).issues.map((i) => i.rule)).toEqual([6, 6]);
    expect(validateContracts([c, fixture({ id: 'fake.other' })], FAKE_ACTIONS).ok).toBe(true);
  });
});

describe('booking.book@1', () => {
  it('passes every rule against the real ACTION_REGISTRY', () => {
    expect(validateContract(BOOKING_BOOK_V1, ACTION_REGISTRY, CONTRACTS, ACTION_ERROR_CODES)).toEqual({ ok: true, issues: [] });
    expect(validateContracts(CONTRACTS, ACTION_REGISTRY, ACTION_ERROR_CODES).ok).toBe(true);
  });

  it('declares slots in ask order with the action input paths', () => {
    expect(BOOKING_BOOK_V1.slots.map((s) => [s.name, s.inputPath, s.askId, s.heldFrom ?? null])).toEqual([
      ['service', 'serviceIds', 'ask.service', null],
      ['staff', 'staffId', 'ask.staff', null],
      ['time', 'start', 'ask.time', null],
      ['customerName', 'customer.name', 'ask.customerName', 'verifiedName'],
      ['customerPhone', 'customer.phone', 'ask.customerPhone', 'callerPhone'],
    ]);
    expect(BOOKING_BOOK_V1.slots.every((s) => s.required && s.defaultAsk.en && s.defaultAsk.es)).toBe(true);
    expect(BOOKING_BOOK_V1.voiceRefs).toBe(false);
    expect(BOOKING_BOOK_V1.onFailure.CONFLICT.map((s) => s.step)).toEqual(['offer_alternatives', 'ask_again', 'message_ticket']);
  });

  it('getContract resolves id@version and bare id', () => {
    expect(getContract('booking.book@1')).toBe(BOOKING_BOOK_V1);
    expect(getContract('booking.book')).toBe(BOOKING_BOOK_V1);
    expect(getContract('booking.book@2')).toBeUndefined();
  });
});
