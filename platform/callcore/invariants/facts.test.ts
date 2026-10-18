import { describe, expect, it } from 'vitest';
import {
  createCallFacts,
  onAgentSpoke,
  onCallerHeard,
  onExplicitYes,
  onFloorEvaluated,
  onPrepared,
  onToolResult,
} from './facts';
import { canonicalRef, findRefs, normalizeArgs, normalizeSpeech } from './normalize';

const init = {
  callId: 'CA-test',
  transferNumberConfigured: true,
  voiceRefs: false,
  smsEnabled: false,
  allowedActions: ['scheduling.book.commit'],
};

describe('CallFacts reducers', () => {
  it('starts empty and unheard', () => {
    const f = createCallFacts(init);
    expect(f).toMatchObject({
      callId: 'CA-test',
      heard: false,
      committed: [],
      floorEvaluated: false,
      unvoicedToolResult: false,
    });
    expect(f.explicitYesForToken).toBeUndefined();
    expect(f.preparedTokens.size).toBe(0);
  });

  it('never mutates its input', () => {
    const f0 = createCallFacts(init);
    const snapshot = JSON.stringify({ ...f0, preparedTokens: [...f0.preparedTokens] });
    const f1 = onExplicitYes(onPrepared(onCallerHeard(f0), 'tok-1'), 'tok-1');
    onFloorEvaluated(onAgentSpoke(onToolResult(f1, { action: 'scheduling.book.commit', kind: 'commit', ok: true, confirmationToken: 'tok-1' })));
    expect(JSON.stringify({ ...f0, preparedTokens: [...f0.preparedTokens] })).toBe(snapshot);
    expect(f1.preparedTokens.has('tok-1')).toBe(true);
  });

  it('records commit/write/transfer results, not reads or prepares; any result is unvoiced until the agent speaks', () => {
    let f = createCallFacts(init);
    f = onToolResult(f, { action: 'scheduling.check_availability', kind: 'read', ok: true });
    f = onToolResult(f, { action: 'scheduling.book.prepare', kind: 'prepare', ok: true });
    expect(f.committed).toEqual([]);
    expect(f.unvoicedToolResult).toBe(true);
    f = onAgentSpoke(f);
    expect(f.unvoicedToolResult).toBe(false);
    f = onToolResult(f, { action: 'scheduling.book.commit', kind: 'commit', ok: true, refs: ['BK-4712'] });
    f = onToolResult(f, { action: 'call.transfer', kind: 'transfer', ok: false, refs: ['X'] });
    expect(f.committed).toEqual([
      { action: 'scheduling.book.commit', kind: 'commit', ok: true, refs: ['BK-4712'] },
      { action: 'call.transfer', kind: 'transfer', ok: false, refs: [] },
    ]);
  });

  it('an explicit yes only sticks for a prepared token', () => {
    const f = createCallFacts(init);
    expect(onExplicitYes(f, 'tok-1').explicitYesForToken).toBeUndefined();
    expect(onExplicitYes(onPrepared(f, 'tok-1'), 'tok-1').explicitYesForToken).toBe('tok-1');
  });

  it('heard and floor flags are one-way', () => {
    const f = onFloorEvaluated(onCallerHeard(createCallFacts(init)));
    expect(f.heard).toBe(true);
    expect(f.floorEvaluated).toBe(true);
    expect(onCallerHeard(f)).toBe(f);
    expect(onFloorEvaluated(f)).toBe(f);
  });
});

describe('normalize helpers', () => {
  it('normalizeSpeech folds case, diacritics, apostrophes and punctuation', () => {
    expect(normalizeSpeech('¡Ya quedó, You’re  BOOKED!')).toBe('ya quedo youre booked');
  });

  it('findRefs finds ref-shaped strings and leaves times, prices and short numbers alone', () => {
    expect(findRefs('Your ref is BK-4712 or 47125.')).toEqual(['BK-4712', '47125']);
    expect(findRefs('BK-47125')).toEqual(['BK-47125']);
    expect(findRefs('At 9:30 on 10/17, $25, room 101, is 4712.')).toEqual([]);
    // A full phone number is ref-shaped too (documented false positive).
    expect(findRefs('Call 555-1234.')).toEqual(['555-1234']);
  });

  it('canonicalRef ignores case, spaces and dashes', () => {
    expect(canonicalRef('bk 47-12')).toBe(canonicalRef('BK-4712'));
  });

  it('normalizeArgs is stable across key order, case and spacing', () => {
    expect(normalizeArgs({ b: ' Marcus ', a: [1, 'X'] })).toBe(normalizeArgs({ a: [1, 'x'], b: 'marcus', c: undefined }));
    expect(normalizeArgs(undefined)).toBe(normalizeArgs({}));
    expect(normalizeArgs({ a: 1 })).not.toBe(normalizeArgs({ a: 2 }));
  });
});
