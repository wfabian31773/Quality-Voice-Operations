import { describe, expect, it } from 'vitest';
import {
  bindSessionToolArgs,
  CALLER_ID_TOKEN,
  isCallerIdReference,
  phonesMatch,
  resolveCallerPhone,
  transcriptIncludesPhone,
} from './sessionBinding';

const session = {
  tenantId: 'demo',
  agentId: 'salon-agent',
  callerNumber: '+15555550199',
  transcript: 'Hi, I want a haircut. My name is Jordan.',
};

describe('bindSessionToolArgs', () => {
  it('rejects a model-supplied tenant or agent id that does not match the session', () => {
    expect(bindSessionToolArgs({ tenantId: 'other-tenant', title: 'Cut' }, session).ok).toBe(false);
    expect(bindSessionToolArgs({ agentId: 'someone-else', title: 'Cut' }, session).ok).toBe(false);
    expect(bindSessionToolArgs({ tenant_id: 'demo', agentSlug: 'wrong' }, session).reason).toMatch(/agent/);
  });

  it('strips matching identity fields so they cannot be forwarded as tool data', () => {
    const bound = bindSessionToolArgs({ tenantId: 'demo', agentId: 'salon-agent', title: 'Cut' }, session);
    expect(bound.ok).toBe(true);
    expect(bound.args.tenantId).toBeUndefined();
    expect(bound.args.agentId).toBeUndefined();
    expect(bound.args.title).toBe('Cut');
    expect(bound.args.contactPhone).toBe('+15555550199');
  });

  it('defaults contactPhone and toNumber to the session caller id', () => {
    const bound = bindSessionToolArgs({ title: 'Cut', body: 'See you Friday' }, session);
    expect(bound.ok).toBe(true);
    expect(bound.args.contactPhone).toBe('+15555550199');
    expect(bound.args.toNumber).toBe('+15555550199');
  });

  it('rejects a different contact phone that the caller never said', () => {
    const bound = bindSessionToolArgs({ contactPhone: '+15559990000' }, session);
    expect(bound.ok).toBe(false);
    expect(bound.reason).toMatch(/not spoken/);
  });

  it('allows a different contact phone when the caller said that number', () => {
    const spoken = {
      ...session,
      transcript: 'You can reach me at 555-201-3344 instead.',
    };
    const bound = bindSessionToolArgs({ contactPhone: '555-201-3344' }, spoken);
    expect(bound.ok).toBe(true);
    expect(bound.args.contactPhone).toBe('555-201-3344');
  });

  it('accepts the session caller id in any common phone format', () => {
    const bound = bindSessionToolArgs({ contactPhone: '555-555-0199' }, session);
    expect(bound.ok).toBe(true);
    expect(bound.args.contactPhone).toBe('+15555550199');
  });

  it.each(['calling number', 'caller_id', 'the number I\'m calling from', 'Caller ID'])(
    'swaps a caller-ID reference (%s) for the session caller id instead of rejecting it',
    (contactPhone) => {
      const bound = bindSessionToolArgs({ contactPhone, toNumber: CALLER_ID_TOKEN }, session);
      expect(bound.ok).toBe(true);
      expect(bound.args.contactPhone).toBe('+15555550199');
      expect(bound.args.toNumber).toBe('+15555550199');
    },
  );

  it('blanks a caller-ID reference when the call has no caller ID', () => {
    const bound = bindSessionToolArgs({ contactPhone: 'calling number' }, { ...session, callerNumber: '' });
    expect(bound.ok).toBe(true);
    expect(bound.args.contactPhone).toBe('');
  });
});

describe('caller-ID references', () => {
  it('treats empty values, the token and caller-ID phrases as the caller ID', () => {
    for (const value of [undefined, null, '', '  ', 'caller_id', 'calling number', 'same number', 'this number']) {
      expect(isCallerIdReference(value)).toBe(true);
    }
    expect(resolveCallerPhone('calling number', '+15555550199')).toBe('+15555550199');
    expect(resolveCallerPhone('', '+15555550199')).toBe('+15555550199');
  });

  it('keeps real numbers and unrelated text', () => {
    expect(isCallerIdReference('555-201-3344')).toBe(false);
    expect(isCallerIdReference('my cell')).toBe(false);
    expect(resolveCallerPhone(' 555-201-3344 ', '+15555550199')).toBe('555-201-3344');
  });
});

describe('phone helpers', () => {
  it('matches numbers with or without country code and punctuation', () => {
    expect(phonesMatch('+1 (555) 555-0199', '5555550199')).toBe(true);
    expect(phonesMatch('555-555-0199', '15555550199')).toBe(true);
    expect(phonesMatch('555-555-0199', '555-555-0188')).toBe(false);
  });

  it('finds a spoken number in a transcript', () => {
    expect(transcriptIncludesPhone('call me at 555.201.3344 please', '5552013344')).toBe(true);
    expect(transcriptIncludesPhone('no number here', '5552013344')).toBe(false);
  });
});
