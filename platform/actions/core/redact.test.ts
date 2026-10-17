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
});

describe('requestHash', () => {
  it('is stable across key order', () => {
    expect(canonicalize({ b: 1, a: { z: 2, y: [3, 1] } })).toBe(canonicalize({ a: { y: [3, 1], z: 2 }, b: 1 }));
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
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
