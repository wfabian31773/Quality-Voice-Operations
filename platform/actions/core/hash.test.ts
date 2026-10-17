import { describe, expect, it } from 'vitest';
import { canonicalize, requestHash } from './hash';

describe('requestHash', () => {
  it('serializes Dates as ISO so different instants hash differently', () => {
    const morning = new Date('2026-10-17T09:00:00.000Z');
    const evening = new Date('2026-10-17T21:00:00.000Z');
    expect(canonicalize(morning)).toBe(JSON.stringify(morning.toISOString()));
    expect(canonicalize({ when: morning })).toBe(JSON.stringify({ when: morning.toISOString() }));
    expect(canonicalize(morning)).not.toBe(canonicalize({}));
    expect(requestHash({ when: morning })).not.toBe(requestHash({ when: evening }));
    expect(requestHash({ when: morning })).not.toBe(requestHash({}));
    expect(requestHash(morning)).not.toBe(requestHash(evening));
    expect(requestHash({ when: morning })).toBe(requestHash({ when: new Date(morning.getTime()) }));
  });
});
