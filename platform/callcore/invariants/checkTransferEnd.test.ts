import { describe, expect, it } from 'vitest';
import { checkEnd, checkTransfer } from './checks';
import { createCallFacts, onAgentSpoke, onCallerHeard, onFloorEvaluated, onToolResult } from './facts';
import { INSTRUCTIONS } from './instructions';
import type { CallFacts, EndReason } from './types';

function facts(transferNumberConfigured = false): CallFacts {
  return createCallFacts({
    callId: 'CA-test',
    transferNumberConfigured,
    voiceRefs: false,
    smsEnabled: false,
    allowedActions: ['scheduling.check_availability'],
  });
}

function blocked(rule: keyof typeof INSTRUCTIONS) {
  return { ok: false, rule, instruction: INSTRUCTIONS[rule] };
}

const withUnvoicedResult = (f: CallFacts) =>
  onToolResult(f, { action: 'scheduling.check_availability', kind: 'read', ok: true });

describe('checkTransfer', () => {
  it('blocks a transfer with no configured number', () => {
    expect(checkTransfer(facts(false))).toEqual(blocked('transfer.no_number'));
  });

  it('allows a transfer with a configured number', () => {
    expect(checkTransfer(facts(true))).toEqual({ ok: true });
  });
});

describe('checkEnd: floor first for a heard caller', () => {
  it('END before the floor is evaluated on a heard call is blocked', () => {
    expect(checkEnd(onCallerHeard(facts()), 'agent_goodbye')).toEqual(blocked('end.floor_not_evaluated'));
    expect(checkEnd(onCallerHeard(facts()), 'silence')).toEqual(blocked('end.floor_not_evaluated'));
  });

  it('max_duration still needs the floor evaluated first', () => {
    expect(checkEnd(onCallerHeard(facts()), 'max_duration')).toEqual(blocked('end.floor_not_evaluated'));
    expect(checkEnd(onFloorEvaluated(onCallerHeard(facts())), 'max_duration')).toEqual({ ok: true });
  });

  it('END after the floor is evaluated is allowed', () => {
    expect(checkEnd(onFloorEvaluated(onCallerHeard(facts())), 'agent_goodbye')).toEqual({ ok: true });
  });

  it('a never-heard caller needs no floor', () => {
    expect(checkEnd(facts(), 'never_heard')).toEqual({ ok: true });
  });
});

describe('checkEnd: unvoiced-answer hangup guard', () => {
  const heardAndFloored = () => onFloorEvaluated(onCallerHeard(facts()));

  it('blocks END while a tool result has not been voiced', () => {
    for (const reason of ['agent_goodbye', 'silence'] as EndReason[]) {
      expect(checkEnd(withUnvoicedResult(heardAndFloored()), reason), reason).toEqual(blocked('end.unvoiced_tool_result'));
    }
  });

  it('allows END once the agent has spoken after the result', () => {
    expect(checkEnd(onAgentSpoke(withUnvoicedResult(heardAndFloored())), 'agent_goodbye')).toEqual({ ok: true });
  });

  it('max_duration and never_heard may end with an unvoiced result', () => {
    expect(checkEnd(withUnvoicedResult(heardAndFloored()), 'max_duration')).toEqual({ ok: true });
    expect(checkEnd(withUnvoicedResult(facts()), 'never_heard')).toEqual({ ok: true });
  });
});
