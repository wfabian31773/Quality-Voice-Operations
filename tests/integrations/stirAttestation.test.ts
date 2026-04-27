import { describe, it, expect } from 'vitest';
import {
  extractStirTelemetry,
  parseAttestationLetter,
  isStirAttestationDegraded,
} from '../../platform/telephony/stirAttestation';

describe('parseAttestationLetter', () => {
  it('extracts A / B / C from documented Twilio verstats', () => {
    expect(parseAttestationLetter('TN-Validation-Passed-A')).toBe('A');
    expect(parseAttestationLetter('TN-Validation-Passed-B')).toBe('B');
    expect(parseAttestationLetter('TN-Validation-Passed-C')).toBe('C');
  });

  it('is case-insensitive for verstats echoed by chatty carriers', () => {
    expect(parseAttestationLetter('tn-validation-passed-a')).toBe('A');
    expect(parseAttestationLetter('  TN-Validation-Passed-B  ')).toBe('B');
  });

  it('returns null for failed / no-validation verstats so the UI does not show a misleading attested badge', () => {
    expect(parseAttestationLetter('TN-Validation-Failed-A')).toBeNull();
    expect(parseAttestationLetter('TN-Validation-Failed-B')).toBeNull();
    expect(parseAttestationLetter('No-TN-Validation')).toBeNull();
  });

  it('returns null for empty / nullish / nonsense input', () => {
    expect(parseAttestationLetter(null)).toBeNull();
    expect(parseAttestationLetter(undefined)).toBeNull();
    expect(parseAttestationLetter('')).toBeNull();
    expect(parseAttestationLetter('   ')).toBeNull();
    expect(parseAttestationLetter('something-else')).toBeNull();
  });
});

describe('extractStirTelemetry', () => {
  it('returns null when the callback contains no STIR fields', () => {
    expect(extractStirTelemetry({ CallSid: 'CA1', CallStatus: 'completed' })).toBeNull();
    expect(extractStirTelemetry(null)).toBeNull();
    expect(extractStirTelemetry(undefined)).toBeNull();
  });

  it('captures status, raw verstat, and derived attestation when present', () => {
    const result = extractStirTelemetry({
      CallSid: 'CA1',
      StirStatus: 'signed',
      StirVerstat: 'TN-Validation-Passed-A',
    });
    expect(result).toEqual({
      status: 'signed',
      verstat: 'TN-Validation-Passed-A',
      attestation: 'A',
    });
  });

  it('still returns telemetry when only StirStatus is present (e.g. failed signing)', () => {
    expect(extractStirTelemetry({ StirStatus: 'failed' })).toEqual({
      status: 'failed',
      verstat: null,
      attestation: null,
    });
  });

  it('captures B/C downgrades faithfully so the UI can warn', () => {
    expect(extractStirTelemetry({ StirVerstat: 'TN-Validation-Passed-C' })).toEqual({
      status: null,
      verstat: 'TN-Validation-Passed-C',
      attestation: 'C',
    });
  });

  it('preserves verstat casing for debugging while normalising status to lower-case', () => {
    expect(
      extractStirTelemetry({ StirStatus: 'SIGNED', StirVerstat: 'TN-Validation-Passed-B' }),
    ).toEqual({
      status: 'signed',
      verstat: 'TN-Validation-Passed-B',
      attestation: 'B',
    });
  });
});

describe('isStirAttestationDegraded', () => {
  it('does not warn for clean A attestation or absent telemetry', () => {
    expect(isStirAttestationDegraded(null)).toBe(false);
    expect(isStirAttestationDegraded(undefined)).toBe(false);
    expect(
      isStirAttestationDegraded({ status: 'signed', verstat: 'TN-Validation-Passed-A', attestation: 'A' }),
    ).toBe(false);
  });

  it('warns for B / C attestations', () => {
    expect(
      isStirAttestationDegraded({ status: 'signed', verstat: 'TN-Validation-Passed-B', attestation: 'B' }),
    ).toBe(true);
    expect(
      isStirAttestationDegraded({ status: 'signed', verstat: 'TN-Validation-Passed-C', attestation: 'C' }),
    ).toBe(true);
  });

  it('warns when the carrier failed to validate even if no attestation letter was returned', () => {
    expect(
      isStirAttestationDegraded({ status: 'failed', verstat: null, attestation: null }),
    ).toBe(true);
    expect(
      isStirAttestationDegraded({ status: 'not-signed', verstat: null, attestation: null }),
    ).toBe(true);
    expect(
      isStirAttestationDegraded({ status: null, verstat: 'TN-Validation-Failed-A', attestation: null }),
    ).toBe(true);
  });
});
