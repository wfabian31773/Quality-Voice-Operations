import { describe, it, expect } from 'vitest';
import {
  redactPHI,
  redactPHIAsOf,
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

  it('redacts a full birth date written with a month name (EN/ES)', () => {
    expect(redactPHI('born October 24, 1990')).toBe('born [DOB_REDACTED]');
    expect(redactPHI('mi fecha de nacimiento es 15 de enero de 1990')).toBe('mi fecha de nacimiento es [DOB_REDACTED]');
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

describe('redactPHIAsOf: appointment dates vs birth dates', () => {
  const NOW = new Date('2026-10-20T15:00:00.000Z');
  const at = (text: string) => redactPHIAsOf(text, NOW);

  it('keeps current- and next-year appointment dates with no birth cue (US, ISO, EN, ES)', () => {
    for (const line of [
      'booked for 10/24/2026',
      'booked for 2026-10-24',
      'moved to 1/5/2027',
      'start 2027-01-05T10:00:00',
      'You are booked for October 24, 2026 at 3pm',
      'Booked Oct 24th',
      'cita reservada para el 24/10/2026',
      'su cita es el 24 de octubre de 2026',
      'nos vemos el 5 de enero del 2027',
      'tomorrow, 10/21',
    ]) {
      expect(at(line)).toBe(line);
    }
  });

  it('redacts any date when a birth cue is in the text (EN)', () => {
    expect(at('born 10/24/2026')).toBe('born [DOB_REDACTED]');
    expect(at('DOB: 2026-03-02')).toBe('DOB: [DOB_REDACTED]');
    expect(at('d.o.b. 3/2')).toBe('d.o.b. [DOB_REDACTED]');
    expect(at('my birthday is Oct 24')).toBe('my birthday is [DOB_REDACTED]');
    expect(at('Date of Birth 24 October')).toBe('Date of Birth [DOB_REDACTED]');
    expect(at('10/24 is my BIRTHDAY')).toBe('[DOB_REDACTED] is my BIRTHDAY');
  });

  it('redacts any date when a birth cue is in the text (ES, with or without accents)', () => {
    expect(at('nací el 24/10/2026')).toBe('nací el [DOB_REDACTED]');
    expect(at('naci el 24 de octubre')).toBe('naci el [DOB_REDACTED]');
    expect(at('fecha de nacimiento 2026-03-02')).toBe('fecha de nacimiento [DOB_REDACTED]');
    expect(at('mi cumpleaños es el 3 de marzo')).toBe('mi cumpleaños es el [DOB_REDACTED]');
    expect(at('Nació el 3/2')).toBe('Nació el [DOB_REDACTED]');
  });

  it('redacts dates outside the current/next year even with no cue', () => {
    expect(at('01/15/1990')).toBe('[DOB_REDACTED]');
    expect(at('1990-01-15')).toBe('[DOB_REDACTED]');
    expect(at('January 15, 1990')).toBe('[DOB_REDACTED]');
    expect(at('15 de enero de 1990')).toBe('[DOB_REDACTED]');
    expect(at('last visit 10/24/2025')).toBe('last visit [DOB_REDACTED]');
    expect(at('2030-01-01')).toBe('[DOB_REDACTED]');
  });

  it('redacts two-digit years, which could be a birth year', () => {
    expect(at('01/15/90')).toBe('[DOB_REDACTED]');
    expect(at('10/24/26')).toBe('[DOB_REDACTED]');
  });

  it('takes the year from the clock passed in', () => {
    expect(redactPHIAsOf('booked for 10/24/2026', new Date('2029-06-01T00:00:00.000Z'))).toBe('booked for [DOB_REDACTED]');
    expect(redactPHIAsOf('booked for 01/15/1990', new Date('1990-01-01T00:00:00.000Z'))).toBe('booked for 01/15/1990');
  });

  it('a kept date leaves phone and SSN redaction unchanged', () => {
    expect(at('booked 10/24/2026, call 555-123-4567, ssn 123-45-6789')).toBe(
      'booked 10/24/2026, call [PHONE_REDACTED], ssn [SSN_REDACTED]',
    );
  });

  it('does not take words that contain a cue or a month as one', () => {
    expect(at('stubborn caller, booked 10/24/2026')).toBe('stubborn caller, booked 10/24/2026');
    expect(at('servicio nacional, cita 24/10/2026')).toBe('servicio nacional, cita 24/10/2026');
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
