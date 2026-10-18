import { describe, expect, it } from 'vitest';
import { checkRun, SUCCESS_RUN_CEILING } from './checks';
import { appendRun, createCallFacts, onExplicitYes, onPrepared, onToolResult } from './facts';
import { INSTRUCTIONS } from './instructions';
import type { CallFacts, RunRecord, RunRequest } from './types';

const AVAILABILITY = 'scheduling.check_availability';
const BOOK_PREPARE = 'scheduling.book.prepare';
const BOOK_COMMIT = 'scheduling.book.commit';
const LIST_STAFF = 'scheduling.list_staff';

function facts(): CallFacts {
  return createCallFacts({
    callId: 'CA-test',
    transferNumberConfigured: false,
    voiceRefs: false,
    smsEnabled: false,
    allowedActions: [AVAILABILITY, BOOK_PREPARE, BOOK_COMMIT, LIST_STAFF],
  });
}

const commit = (token?: string): RunRequest => ({ action: BOOK_COMMIT, kind: 'commit', confirmationToken: token });

function blocked(rule: keyof typeof INSTRUCTIONS) {
  return { ok: false, rule, instruction: INSTRUCTIONS[rule] };
}

describe('checkRun: allowed actions', () => {
  it('allows an action from the selected contracts', () => {
    expect(checkRun(facts(), { action: AVAILABILITY, kind: 'read', args: { date: '2026-10-17' } })).toEqual({ ok: true });
  });

  it('blocks an action no selected contract lists', () => {
    expect(checkRun(facts(), { action: 'sms.send', kind: 'write' })).toEqual(blocked('run.action_not_allowed'));
    expect(checkRun(facts(), { action: 'tickets.update', kind: 'write' })).toEqual(blocked('run.action_not_allowed'));
  });
});

describe('checkRun: commit needs a prepared token and an explicit yes for it', () => {
  it('commit without an explicit yes is blocked', () => {
    const f = onPrepared(facts(), 'tok-1');
    expect(checkRun(f, commit('tok-1'))).toEqual(blocked('run.commit_without_yes'));
  });

  it('commit with no token, or a token not prepared on this call, is blocked', () => {
    expect(checkRun(facts(), commit())).toEqual(blocked('run.commit_without_token'));
    expect(checkRun(facts(), commit('tok-from-elsewhere'))).toEqual(blocked('run.commit_token_not_prepared'));
    // A yes for an unprepared token is ignored, so it can't authorize anything.
    expect(checkRun(onExplicitYes(facts(), 'tok-x'), commit('tok-x'))).toEqual(blocked('run.commit_token_not_prepared'));
  });

  it('a yes for a different token does not authorize this one (a correction means a new prepare)', () => {
    let f = onPrepared(facts(), 'tok-1');
    f = onExplicitYes(f, 'tok-1');
    f = onPrepared(f, 'tok-2');
    expect(checkRun(f, commit('tok-2'))).toEqual(blocked('run.commit_without_yes'));
    expect(checkRun(f, commit('tok-1'))).toEqual({ ok: true });
  });

  it('prepared + explicit yes for the same token is allowed, and an ok commit retires the token', () => {
    let f = onExplicitYes(onPrepared(facts(), 'tok-1'), 'tok-1');
    expect(checkRun(f, commit('tok-1'))).toEqual({ ok: true });
    f = onToolResult(f, { action: BOOK_COMMIT, kind: 'commit', ok: true, confirmationToken: 'tok-1' });
    expect(checkRun(f, commit('tok-1'))).toEqual(blocked('run.commit_token_not_prepared'));
  });

  it('a failed commit keeps the token so the same confirmed commit can retry', () => {
    let f = onExplicitYes(onPrepared(facts(), 'tok-1'), 'tok-1');
    f = onToolResult(f, { action: BOOK_COMMIT, kind: 'commit', ok: false, confirmationToken: 'tok-1' });
    expect(checkRun(f, commit('tok-1'))).toEqual({ ok: true });
  });

  it('prepare and read need no token', () => {
    expect(checkRun(facts(), { action: BOOK_PREPARE, kind: 'prepare', args: { service: 'fade' } })).toEqual({ ok: true });
  });
});

describe('checkRun: success-run ceiling', () => {
  const read: RunRequest = { action: AVAILABILITY, kind: 'read', args: { date: '2026-10-17', staff: 'Marcus' } };

  function runs(n: number, req: RunRequest = read, ok = true): RunRecord[] {
    let h: RunRecord[] = [];
    for (let i = 0; i < n; i += 1) h = appendRun(h, req, ok);
    return h;
  }

  it(`10 identical successful reads in a row: the ${SUCCESS_RUN_CEILING}th is blocked`, () => {
    expect(SUCCESS_RUN_CEILING).toBe(10);
    let history: RunRecord[] = [];
    for (let i = 1; i < SUCCESS_RUN_CEILING; i += 1) {
      expect(checkRun(facts(), read, history), `run ${i}`).toEqual({ ok: true });
      history = appendRun(history, read, true);
    }
    expect(checkRun(facts(), read, history)).toEqual(blocked('run.success_run_ceiling'));
  });

  it('args are normalized: key order, case and spacing do not make a read "different"', () => {
    const same: RunRequest = { action: AVAILABILITY, kind: 'read', args: { staff: ' marcus ', date: '2026-10-17' } };
    expect(checkRun(facts(), same, runs(9))).toEqual(blocked('run.success_run_ceiling'));
  });

  it('different args, another action in between, or a failed read break the run', () => {
    const other: RunRequest = { action: AVAILABILITY, kind: 'read', args: { date: '2026-10-18', staff: 'Marcus' } };
    expect(checkRun(facts(), other, runs(9))).toEqual({ ok: true });

    const interrupted = appendRun(runs(8), { action: LIST_STAFF, kind: 'read' }, true);
    expect(checkRun(facts(), read, interrupted)).toEqual({ ok: true });

    const withFailure = [...runs(4), ...runs(1, read, false), ...runs(4)];
    expect(checkRun(facts(), read, withFailure)).toEqual({ ok: true });
  });

  it('does not apply to prepare/commit (those have their own token rules)', () => {
    const prep: RunRequest = { action: BOOK_PREPARE, kind: 'prepare', args: { service: 'fade' } };
    expect(checkRun(facts(), prep, runs(12, prep))).toEqual({ ok: true });
  });

  it('appendRun keeps a short history', () => {
    expect(runs(25)).toHaveLength(SUCCESS_RUN_CEILING);
  });
});
