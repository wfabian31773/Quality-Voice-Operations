import { describe, expect, it, vi } from 'vitest';
import { closeRealtimeForPhoneTeardown, type PhoneTeardownSession } from './phoneCallTeardown';
import type { FloorOutcome } from './callInvariants';

function fakeSession(overrides: Partial<PhoneTeardownSession> = {}) {
  const order: string[] = [];
  const session: PhoneTeardownSession = {
    recordCallOutcome: vi.fn(() => { order.push('outcome'); return true; }),
    session: { close: vi.fn(() => { order.push('close'); }) },
    evaluateFloor: vi.fn(async (): Promise<FloorOutcome> => { order.push('floor'); return 'filed'; }),
    ...overrides,
  };
  const log = { info: vi.fn(), error: vi.fn() };
  return { session, log, order };
}

describe('closeRealtimeForPhoneTeardown', () => {
  it('records the default outcome, closes the realtime session, then starts the floor', async () => {
    const { session, log, order } = fakeSession();
    const { floor } = await closeRealtimeForPhoneTeardown(session, 'caller_hangup', log);
    await expect(floor).resolves.toBe('filed');
    expect(session.recordCallOutcome).toHaveBeenCalledWith('caller_hangup');
    expect(order).toEqual(['outcome', 'close', 'floor']);
    expect(log.info).toHaveBeenCalledWith('OpenAI realtime session closed');
  });

  it('a failing close is logged and the floor still runs', async () => {
    const { session, log } = fakeSession({ session: { close: vi.fn(async () => { throw new Error('socket gone'); }) } });
    const { floor } = await closeRealtimeForPhoneTeardown(session, 'provider_failure', log);
    await expect(floor).resolves.toBe('filed');
    expect(log.error).toHaveBeenCalledWith('Error closing OpenAI session', { error: 'Error: socket gone' });
  });

  it('the floor promise never rejects, even if evaluateFloor throws synchronously', async () => {
    const rejecting = fakeSession({ evaluateFloor: vi.fn(async () => { throw new Error('boom'); }) });
    await expect((await closeRealtimeForPhoneTeardown(rejecting.session, 'caller_hangup', rejecting.log)).floor).resolves.toBe('error');
    const throwing = fakeSession({ evaluateFloor: vi.fn(() => { throw new Error('sync boom'); }) });
    await expect((await closeRealtimeForPhoneTeardown(throwing.session, 'caller_hangup', throwing.log)).floor).resolves.toBe('error');
  });

  it('holds a deploy drain from before the close until the floor settles', async () => {
    let finish!: (outcome: FloorOutcome) => void;
    const { session, log, order } = fakeSession({
      evaluateFloor: vi.fn(() => new Promise<FloorOutcome>((resolve) => { finish = resolve; })),
    });
    const release = vi.fn(() => { order.push('release'); });
    const holdDrain = vi.fn(() => { order.push('hold'); return release; });
    const { floor } = await closeRealtimeForPhoneTeardown(session, 'caller_hangup', log, { holdDrain });
    expect(order).toEqual(['hold', 'outcome', 'close']);
    expect(release).not.toHaveBeenCalled();
    finish('filed');
    await expect(floor).resolves.toBe('filed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('outbound: never evaluates the floor, still records the outcome, closes the session and releases the drain hold', async () => {
    const { session, log, order } = fakeSession();
    const release = vi.fn(() => { order.push('release'); });
    const holdDrain = vi.fn(() => { order.push('hold'); return release; });
    const { floor } = await closeRealtimeForPhoneTeardown(session, 'caller_hangup', log, { holdDrain, direction: 'outbound' });
    await expect(floor).resolves.toBe('skipped_outbound');
    expect(session.evaluateFloor).not.toHaveBeenCalled();
    expect(session.recordCallOutcome).toHaveBeenCalledWith('caller_hangup');
    expect(order).toEqual(['hold', 'outcome', 'close', 'release']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('floor_evaluated', { outcome: 'skipped_outbound' });
  });

  it('inbound: evaluates the floor once', async () => {
    const { session, log } = fakeSession();
    const { floor } = await closeRealtimeForPhoneTeardown(session, 'caller_hangup', log, { direction: 'inbound' });
    await expect(floor).resolves.toBe('filed');
    expect(session.evaluateFloor).toHaveBeenCalledTimes(1);
  });
});
