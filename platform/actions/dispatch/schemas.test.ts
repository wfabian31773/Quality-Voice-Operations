import { describe, expect, it } from 'vitest';
import {
  createJobCommitInput,
  createJobPrepareInput,
  getJobStatusInput,
  updateStatusInput,
} from './schemas';

const ADDRESS = {
  line1: '123 Main St',
  unit: 'Apt 4B',
  city: 'Springfield',
  region: 'IL',
  postal: '62701',
};

const WINDOW = {
  start: '2026-10-20T13:00:00-04:00',
  end: '2026-10-20T17:00:00-04:00',
};

function jobInput(overrides: Record<string, unknown> = {}) {
  return {
    jobType: 'plumbing',
    window: WINDOW,
    address: ADDRESS,
    contact: { name: 'Luis Garcia', phone: '+1 (555) 555-0142' },
    problem: 'The kitchen sink is leaking under the cabinet.',
    urgency: 'normal',
    ...overrides,
  };
}

describe('dispatch job intake schemas', () => {
  it('accepts a complete job and normalizes the phone to E.164', () => {
    const parsed = createJobPrepareInput.parse(jobInput());
    expect(parsed.contact.phone).toBe('+15555550142');
    expect(parsed.address.unit).toBe('Apt 4B');
  });

  it('keeps a blank unit off the address', () => {
    const parsed = createJobPrepareInput.parse(jobInput({ address: { ...ADDRESS, unit: '  ' } }));
    expect(parsed.address.unit).toBeUndefined();
  });

  it('rejects a window whose start is not before its end', () => {
    expect(createJobPrepareInput.safeParse(jobInput({ window: { start: WINDOW.end, end: WINDOW.start } })).success).toBe(
      false,
    );
    expect(createJobPrepareInput.safeParse(jobInput({ window: { start: WINDOW.start, end: WINDOW.start } })).success).toBe(
      false,
    );
  });

  it('rejects out-of-range problem, access notes, name and job type', () => {
    expect(createJobPrepareInput.safeParse(jobInput({ problem: 'x'.repeat(2001) })).success).toBe(false);
    expect(createJobPrepareInput.safeParse(jobInput({ accessNotes: 'x'.repeat(501) })).success).toBe(false);
    expect(createJobPrepareInput.safeParse(jobInput({ jobType: '' })).success).toBe(false);
    expect(createJobPrepareInput.safeParse(jobInput({ contact: { name: '', phone: '+15555550142' } })).success).toBe(
      false,
    );
    expect(createJobPrepareInput.safeParse(jobInput({ problem: '' })).success).toBe(false);
  });

  it('rejects a non-E.164 phone', () => {
    expect(
      createJobPrepareInput.safeParse(jobInput({ contact: { name: 'Luis', phone: 'not-a-number' } })).success,
    ).toBe(false);
  });

  it('requires a confirmation token uuid on commit', () => {
    expect(createJobCommitInput.safeParse({ confirmationToken: 'nope' }).success).toBe(false);
    expect(createJobCommitInput.safeParse({ confirmationToken: '7c1e4b2a-93d5-4f60-8a21-5b9e0d3c6f48' }).success).toBe(
      true,
    );
  });

  it('rejects an unknown update status and a missing name on get', () => {
    expect(updateStatusInput.safeParse({ jobId: 'j1', status: 'no_show' }).success).toBe(false);
    expect(updateStatusInput.safeParse({ jobId: 'j1', status: 'en_route' }).success).toBe(true);
    expect(getJobStatusInput.safeParse({ phone: '+15555550142' }).success).toBe(false);
    expect(getJobStatusInput.safeParse({ phone: '+15555550142', name: 'Luis' }).success).toBe(true);
  });
});
