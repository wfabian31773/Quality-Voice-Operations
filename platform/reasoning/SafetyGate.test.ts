import { describe, it, expect } from 'vitest';
import { SafetyGate } from './SafetyGate';
import type { ConfidenceScore, SafetyViolationType, TenantPolicy } from './types';
import {
  makeReasoningContext,
  makeSlotManifest,
  makeSlotTrackerState,
} from './__fixtures__/reasoningContext';

function makeConfidence(
  overall: ConfidenceScore['overall'] = 'high',
  slotCompleteness = 1,
): ConfidenceScore {
  return {
    overall,
    numericScore: overall === 'high' ? 0.9 : overall === 'medium' ? 0.55 : 0.2,
    factors: {
      intentCertainty: overall,
      slotCompleteness,
      toolResultCertainty: 'high',
      conversationAmbiguity: 'low',
      turnsWithoutProgress: 0,
    },
    timestamp: new Date(),
  };
}

const types = (r: { violations: { type: SafetyViolationType }[] }) =>
  r.violations.map((v) => v.type);

describe('SafetyGate.checkPreExecution', () => {
  it('blocks a healthcare professional caller outcome without an organization name', () => {
    const ctx = makeReasoningContext({
      vertical: 'healthcare-receptionist',
      toolsAvailable: ['createServiceTicket'],
    });
    const result = new SafetyGate('healthcare-receptionist').checkPreExecution(
      ctx,
      'createServiceTicket',
      {
        callerFirstName: 'Morgan',
        callerLastName: 'Lee',
        callerPhone: '+15555550120',
        callbackNumber: '+15555550120',
        callerType: 'pharmacy',
        reasonForCall: 'Refill question',
        outcomeType: 'staff_message',
        requestedAction: 'Callback',
        urgency: 'routine',
        callbackPreference: 'morning',
        identityVerificationStatus: 'partially_verified',
        consentToContact: true,
        evidenceSource: ['caller_statement'],
      },
      makeConfidence('high'),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('missing_required_data');
  });

  it('blocks a healthcare human escalation that has no reason', () => {
    const ctx = makeReasoningContext({
      vertical: 'healthcare-receptionist',
      toolsAvailable: ['escalate_to_human'],
    });
    const result = new SafetyGate('healthcare-receptionist').checkPreExecution(
      ctx,
      'escalate_to_human',
      { reason: '   ' },
      makeConfidence('high'),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('missing_required_data');
  });

  it('blocks an unverified healthcare schedule lookup', () => {
    const ctx = makeReasoningContext({
      vertical: 'healthcare-receptionist',
      toolsAvailable: ['lookupSchedule'],
    });
    const result = new SafetyGate('healthcare-receptionist').checkPreExecution(
      ctx,
      'lookupSchedule',
      { phone: '+15555550100' },
      makeConfidence('high'),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('phi_exposure_risk');
  });

  it('allows a tool when it is authorized and all required data is present', () => {
    const ctx = makeReasoningContext({
      toolsAvailable: ['createServiceTicket'],
      slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
    });
    const result = new SafetyGate('hvac').checkPreExecution(
      ctx,
      'createServiceTicket',
      {},
      makeConfidence('high'),
    );
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('blocks a tool when manifest-required slots are unfilled', () => {
    const ctx = makeReasoningContext({ toolsAvailable: ['createServiceTicket'] });
    const result = new SafetyGate('hvac').checkPreExecution(
      ctx,
      'createServiceTicket',
      {},
      makeConfidence('high'),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('missing_required_data');
    expect(result.violations[0].description).toContain('caller_name');
  });

  it('blocks a tool that is not in the agent toolset', () => {
    const ctx = makeReasoningContext({
      toolsAvailable: [],
      slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
    });
    const result = new SafetyGate('hvac').checkPreExecution(
      ctx,
      'createServiceTicket',
      {},
      makeConfidence('high'),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('unauthorized_tool');
  });

  it('blocks when required data was filled only from model tool args, not the caller', () => {
    const ctx = makeReasoningContext({
      toolsAvailable: ['createServiceTicket'],
      slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
    });
    const result = new SafetyGate('hvac').checkPreExecution(
      ctx,
      'createServiceTicket',
      {},
      makeConfidence('high'),
      new Set(['caller_name']),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('missing_required_data');
    expect(result.violations[0].description).toContain('caller-provided');
  });

  it('flags a hallucinated confirmation: a boolean-true arg under low confidence and sparse data', () => {
    const ctx = makeReasoningContext({
      toolsAvailable: ['createServiceTicket'],
      slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
    });
    const result = new SafetyGate('hvac').checkPreExecution(
      ctx,
      'createServiceTicket',
      { confirmed: true },
      makeConfidence('low', 0.3),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('hallucinated_confirmation');
  });

  it('does not flag confirmation flags when confidence is adequate', () => {
    const ctx = makeReasoningContext({
      toolsAvailable: ['createServiceTicket'],
      slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
    });
    const result = new SafetyGate('hvac').checkPreExecution(
      ctx,
      'createServiceTicket',
      { confirmed: true },
      makeConfidence('high', 1),
    );
    expect(types(result)).not.toContain('hallucinated_confirmation');
  });

  describe('default required-data fallback (no manifest-required slots)', () => {
    const optionalOnly = makeSlotTrackerState(
      makeSlotManifest([{ name: 'note', required: false }]),
    );

    it('falls back to the per-tool required list and blocks when those are missing', () => {
      const ctx = makeReasoningContext({
        toolsAvailable: ['createServiceTicket'],
        slotTracker: optionalOnly,
      });
      const result = new SafetyGate().checkPreExecution(
        ctx,
        'createServiceTicket',
        {},
        makeConfidence('high'),
      );
      expect(result.allowed).toBe(false);
      // createServiceTicket requires caller_name, reason_for_call, callback_number
      expect(result.violations[0].description).toContain('reason_for_call');
    });

    it('allows a tool whose default required list is empty (retrieve_knowledge)', () => {
      const ctx = makeReasoningContext({
        toolsAvailable: ['retrieve_knowledge'],
        slotTracker: optionalOnly,
      });
      const result = new SafetyGate().checkPreExecution(
        ctx,
        'retrieve_knowledge',
        {},
        makeConfidence('high'),
      );
      expect(result.allowed).toBe(true);
    });

    it('allows a tool with no manifest-required slots and no default entry', () => {
      const ctx = makeReasoningContext({
        toolsAvailable: ['someUnknownTool'],
        slotTracker: optionalOnly,
      });
      const result = new SafetyGate().checkPreExecution(
        ctx,
        'someUnknownTool',
        {},
        makeConfidence('high'),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('tenant policies', () => {
    const filledCtx = (policies: TenantPolicy[] = []) =>
      makeReasoningContext({
        toolsAvailable: ['createServiceTicket'],
        slotTracker: makeSlotTrackerState(makeSlotManifest(), { caller_name: 'Ada' }),
        tenantPolicies: policies,
      });

    it('blocks a tool named by a block_tool policy (from the constructor)', () => {
      const policy: TenantPolicy = {
        id: 'p1',
        name: 'No tickets after hours',
        type: 'block_tool',
        condition: {},
        action: 'createServiceTicket',
      };
      const result = new SafetyGate('hvac', [policy]).checkPreExecution(
        filledCtx(),
        'createServiceTicket',
        {},
        makeConfidence('high'),
      );
      expect(result.allowed).toBe(false);
      expect(types(result)).toContain('policy_violation');
    });

    it('blocks a tool named by a block_tool policy (from the context)', () => {
      const policy: TenantPolicy = {
        id: 'p2',
        name: 'Block ticketing',
        type: 'block_tool',
        condition: {},
        action: 'createServiceTicket',
      };
      const result = new SafetyGate('hvac').checkPreExecution(
        filledCtx([policy]),
        'createServiceTicket',
        {},
        makeConfidence('high'),
      );
      expect(types(result)).toContain('policy_violation');
    });

    it('requires a confirmation slot before executing the named tool', () => {
      const policy: TenantPolicy = {
        id: 'p3',
        name: 'Confirm before booking',
        type: 'require_confirmation',
        condition: { tool: 'createServiceTicket', confirmationSlot: 'caller_confirmed' },
        action: 'confirm',
      };
      const blocked = new SafetyGate('hvac').checkPreExecution(
        filledCtx([policy]),
        'createServiceTicket',
        {},
        makeConfidence('high'),
      );
      expect(blocked.allowed).toBe(false);
      expect(types(blocked)).toContain('missing_required_data');

      // Once the confirmation slot is filled, the policy is satisfied.
      const ctx = makeReasoningContext({
        toolsAvailable: ['createServiceTicket'],
        slotTracker: makeSlotTrackerState(
          makeSlotManifest([
            { name: 'caller_name', required: true },
            { name: 'caller_confirmed', required: false },
          ]),
          { caller_name: 'Ada', caller_confirmed: 'yes' },
        ),
        tenantPolicies: [policy],
      });
      const allowed = new SafetyGate('hvac').checkPreExecution(
        ctx,
        'createServiceTicket',
        {},
        makeConfidence('high'),
      );
      expect(allowed.allowed).toBe(true);
    });
  });
});

describe('SafetyGate.checkResponseSafety', () => {
  it('blocks prohibited medical advice for medical-after-hours and dental verticals', () => {
    for (const vertical of ['medical-after-hours', 'dental']) {
      const result = new SafetyGate(vertical).checkResponseSafety(
        'Based on this, you have a sinus infection.',
        makeReasoningContext({ vertical }),
      );
      expect(result.allowed).toBe(false);
      expect(types(result)).toContain('prohibited_advice');
    }
  });

  it('blocks prohibited legal advice for the legal vertical', () => {
    const result = new SafetyGate('legal').checkResponseSafety(
      'Honestly, you should sue them immediately.',
      makeReasoningContext({ vertical: 'legal' }),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('prohibited_advice');
  });

  it('blocks prohibited financial advice for the insurance vertical', () => {
    const result = new SafetyGate('insurance').checkResponseSafety(
      'You should invest in our premium plan.',
      makeReasoningContext({ vertical: 'insurance' }),
    );
    expect(result.allowed).toBe(false);
    expect(types(result)).toContain('prohibited_advice');
  });

  it('matches prohibited phrases case-insensitively', () => {
    const result = new SafetyGate('legal').checkResponseSafety(
      'YOU SHOULD SUE the contractor.',
      makeReasoningContext({ vertical: 'legal' }),
    );
    expect(result.allowed).toBe(false);
  });

  it('allows the same phrasing when no vertical prohibitions are configured', () => {
    const result = new SafetyGate().checkResponseSafety(
      'you have a few options here',
      makeReasoningContext(),
    );
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('allows a benign response within a regulated vertical', () => {
    const result = new SafetyGate('medical-after-hours').checkResponseSafety(
      'I can take a message and have a nurse call you back.',
      makeReasoningContext({ vertical: 'medical-after-hours' }),
    );
    expect(result.allowed).toBe(true);
  });
});
