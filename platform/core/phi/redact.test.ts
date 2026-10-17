import { describe, it, expect } from 'vitest';
import {
  redactPHI,
  redactGraderResult,
  redactMetadata,
  redactGraderResults,
} from './redact';

describe('redactPHI', () => {
  it('redacts SSNs, phone numbers and dates of birth', () => {
    expect(redactPHI('ssn 123-45-6789')).toContain('[SSN_REDACTED]');
    expect(redactPHI('call me at 555-123-4567')).toContain('[PHONE_REDACTED]');
    expect(redactPHI('born 01/15/1990')).toContain('[DOB_REDACTED]');
    expect(redactPHI('born 1990-15-01')).toContain('[DOB_REDACTED]');
  });

  it('redacts compact E.164 caller numbers used by carrier stream metadata', () => {
    expect(redactPHI('+15551234567')).toBe('[PHONE_REDACTED]');
    expect(redactPHI('caller +442079460958 connected')).toBe('caller [PHONE_REDACTED] connected');
  });

  it('redacts names introduced by common patterns and honorifics', () => {
    expect(redactPHI('my name is Ada Lovelace')).toBe('my name is [NAME_REDACTED]');
    expect(redactPHI('Dr. Smith will see you')).toContain('[NAME_REDACTED]');
  });

  it('leaves ordinary words after "I\'m" alone (Oct 17 transcript)', () => {
    for (const line of [
      "I'm looking for a fade.",
      "You can use the one I'm calling from.",
      "I'm just wondering about prices",
      "I'm Looking for a fade",
      "I'm Good, thanks",
      'this is the front desk',
      "I'm not sure",
    ]) {
      expect(redactPHI(line)).toBe(line);
    }
  });

  it('still redacts real introduced names, including accented ones', () => {
    expect(redactPHI('Hi, this is Wayne.')).toBe('Hi, this is [NAME_REDACTED].');
    expect(redactPHI("I'm Wayne")).toBe("I'm [NAME_REDACTED]");
    expect(redactPHI('this is Maria José')).toBe('this is [NAME_REDACTED]');
    expect(redactPHI('My name is Ada Lovelace')).toBe('My name is [NAME_REDACTED]');
  });

  it('redacts lowercase names after unambiguous lead-ins (STT lowercasing)', () => {
    expect(redactPHI('my name is maria lopez')).toBe('my name is [NAME_REDACTED]');
    expect(redactPHI('patient john smith called')).toBe('patient [NAME_REDACTED]');
    expect(redactPHI('name: ana')).toBe('name: [NAME_REDACTED]');
    expect(redactPHI('patient pat')).toBe('patient [NAME_REDACTED]');
  });

  it('applies the stop words after unambiguous lead-ins too', () => {
    expect(redactPHI('the caller from the front desk')).toBe('the caller from the front desk');
  });

  it('needs a capitalized name after the ambiguous lead-ins', () => {
    expect(redactPHI("i'm wayne")).toBe("i'm wayne");
    expect(redactPHI('this is wayne')).toBe('this is wayne');
  });

  it('returns falsy/empty input unchanged', () => {
    expect(redactPHI('')).toBe('');
  });

  it('redacts multiple PHI tokens in one string', () => {
    const out = redactPHI('this is John Doe, ssn 123-45-6789, phone 555-123-4567');
    expect(out).toContain('[SSN_REDACTED]');
    expect(out).toContain('[PHONE_REDACTED]');
    expect(out).toContain('[NAME_REDACTED]');
  });
});

describe('redactMetadata', () => {
  it('redacts string values and string array elements, leaving others intact', () => {
    const out = redactMetadata({
      note: 'caller 555-123-4567',
      tags: ['ssn 123-45-6789', 42],
      count: 7,
    });
    expect(out.note).toContain('[PHONE_REDACTED]');
    expect((out.tags as unknown[])[0]).toContain('[SSN_REDACTED]');
    expect((out.tags as unknown[])[1]).toBe(42);
    expect(out.count).toBe(7);
  });
});

describe('redactGraderResult', () => {
  it('redacts the reason string and nested metadata', () => {
    const out = redactGraderResult({
      score: 1,
      reason: 'patient Ada Lovelace called',
      metadata: { detail: 'born 01/15/1990' },
    }) as Record<string, unknown>;
    expect(out.reason).toContain('[NAME_REDACTED]');
    expect((out.metadata as Record<string, unknown>).detail).toContain('[DOB_REDACTED]');
    expect(out.score).toBe(1);
  });

  it('passes through non-object input', () => {
    expect(redactGraderResult('plain')).toBe('plain');
    expect(redactGraderResult(null)).toBeNull();
  });
});

describe('redactGraderResults', () => {
  it('maps redaction across a graders array', () => {
    const out = redactGraderResults({
      graders: [{ reason: 'call 555-123-4567' }, { reason: 'no phi here' }],
    }) as { graders: Array<{ reason: string }> };
    expect(out.graders[0].reason).toContain('[PHONE_REDACTED]');
    expect(out.graders[1].reason).toBe('no phi here');
  });

  it('passes through input without a graders array', () => {
    expect(redactGraderResults({ other: 1 })).toEqual({ other: 1 });
    expect(redactGraderResults(null)).toBeNull();
  });
});
