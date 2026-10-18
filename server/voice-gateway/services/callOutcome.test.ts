import { describe, expect, it, vi } from 'vitest';
import { CALL_OUTCOMES, CallOutcomeRecorder } from './callOutcome';

describe('CallOutcomeRecorder', () => {
  it('first writer wins: later outcomes are ignored and the sink runs once', () => {
    const sink = vi.fn();
    const recorder = new CallOutcomeRecorder(sink);
    expect(recorder.outcome).toBeNull();

    expect(recorder.record('never_heard')).toBe(true);
    expect(recorder.record('provider_failure')).toBe(false);
    expect(recorder.record('caller_hangup')).toBe(false);

    expect(recorder.outcome).toBe('never_heard');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('never_heard');
  });

  it('lists the seven outcome values', () => {
    expect([...CALL_OUTCOMES].sort()).toEqual(
      ['agent_ended', 'caller_hangup', 'completed', 'dead_air', 'max_duration', 'never_heard', 'provider_failure'],
    );
  });
});
