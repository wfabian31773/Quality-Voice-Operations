import { describe, expect, it } from 'vitest';
import { classifyProposalRejection } from './proposals';
import { canonicalize, requestHash } from './hash';
import { auditActor, maskPhoneLast4, redactInput } from './redact';
import type { ProposalRecord } from './store';

describe('redactInput', () => {
  it('masks phone fields and inline numbers to last 4', () => {
    expect(redactInput({
      phone: '+15555550142',
      nested: { callbackNumber: '(555) 555-0199' },
      note: 'call +15555550142 please',
      tags: ['+14445556677'],
      count: 2,
    })).toEqual({
      phone: '***0142',
      nested: { callbackNumber: '***0199' },
      note: 'call ***0142 please',
      tags: ['***6677'],
      count: 2,
    });
    expect(maskPhoneLast4('no-digits')).toBe('***');
    expect(auditActor({ type: 'agent', id: 'a1' })).toEqual({ type: 'agent', id: 'a1' });
  });

  it('redacts a parenthesized number that does not follow a word boundary', () => {
    expect(redactInput('Call (555) 555-0142')).toBe('Call ***0142');
    expect(redactInput('Call (555)555-0142 please')).toBe('Call ***0142 please');
  });

  it('stores a JSON object sentinel when the body is missing', () => {
    expect(redactInput(undefined)).toEqual({});
    expect(redactInput(null)).toEqual({});
  });
});

describe('requestHash', () => {
  it('is stable across key order', () => {
    expect(canonicalize({ b: 1, a: { z: 2, y: [3, 1] } })).toBe(canonicalize({ a: { y: [3, 1], z: 2 }, b: 1 }));
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });

  it('serializes Dates and other non-plain values so different instants hash differently', () => {
    const morning = new Date('2026-10-17T09:00:00.000Z');
    const evening = new Date('2026-10-17T21:00:00.000Z');
    expect(canonicalize({ when: morning })).toBe(JSON.stringify({ when: morning.toISOString() }));
    expect(requestHash({ when: morning })).not.toBe(requestHash({ when: evening }));
    expect(requestHash({ when: morning })).toBe(requestHash({ when: new Date(morning.getTime()) }));
    expect(canonicalize({ when: new Date('invalid') })).toBe(JSON.stringify({ when: 'Invalid Date' }));
    expect(canonicalize({ n: 1n, s: Symbol.for('x'), fn: function named() {}, nan: Number.NaN })).toEqual(
      JSON.stringify({ fn: '[Function named]', n: '1n', nan: 'NaN', s: 'Symbol(x)' }),
    );
    expect(canonicalize(new Map([['b', 2], ['a', 1]]))).toContain('__type');
    expect(canonicalize(new Set([2, 1]))).toContain('Set');
    expect(canonicalize(new Uint8Array([1, 2]))).toContain('bytes');
    expect(canonicalize(new ArrayBuffer(2))).toContain('ArrayBuffer');
    class Instant {
      toJSON() {
        return { when: new Date('2026-01-01T00:00:00.000Z') };
      }
    }
    expect(canonicalize(new Instant())).toBe(JSON.stringify({ when: '2026-01-01T00:00:00.000Z' }));
  });
});

describe('classifyProposalRejection', () => {
  const base: ProposalRecord = {
    id: 'tok',
    tenantId: 't1',
    action: 'core.echo.prepare',
    callId: 'call-1',
    payloadHash: 'h'.repeat(64),
    payload: { message: 'hi' },
    readback: 'hi',
    expiresAt: new Date('2026-10-17T15:05:00.000Z'),
    consumedAt: null,
  };
  const expected = {
    now: new Date('2026-10-17T15:00:00.000Z'),
    action: 'core.echo.prepare',
    callId: 'call-1',
    payloadHash: 'h'.repeat(64),
  };

  it('classifies each rejection reason', () => {
    expect(classifyProposalRejection(null, expected)).toMatch(/unknown or expired/i);
    expect(classifyProposalRejection({ ...base, consumedAt: expected.now }, expected)).toMatch(/already been used/i);
    expect(classifyProposalRejection({ ...base, expiresAt: new Date('2026-10-17T14:00:00.000Z') }, expected)).toMatch(/expired/i);
    expect(classifyProposalRejection({ ...base, action: 'other' }, expected)).toMatch(/different action/i);
    expect(classifyProposalRejection({ ...base, callId: 'other' }, expected)).toMatch(/different call/i);
    expect(classifyProposalRejection({ ...base, payloadHash: 'z'.repeat(64) }, expected)).toMatch(/payload has changed/i);
    expect(classifyProposalRejection(base, expected)).toMatch(/not valid/i);
  });
});
