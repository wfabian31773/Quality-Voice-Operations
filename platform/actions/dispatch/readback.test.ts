import { describe, expect, it } from 'vitest';
import { formatAddress, normalizeAddress } from './address';
import { createJobReadback, spokenWindow } from './readback';
import type { CreateJobPrepareInput } from './schemas';

const NOW = Date.parse('2026-10-19T12:00:00.000Z'); // Mon Oct 19 2026, 8:00 AM EDT
const TZ = 'America/New_York';

const WINDOW = {
  start: '2026-10-20T13:00:00-04:00',
  end: '2026-10-20T17:00:00-04:00',
};

const ADDRESS = {
  line1: '123 Main St',
  unit: 'Apt 4B',
  city: 'Springfield',
  region: 'IL',
  postal: '62701',
};

const INPUT: CreateJobPrepareInput = {
  jobType: 'plumbing',
  window: WINDOW,
  address: ADDRESS,
  contact: { name: 'Luis Garcia', phone: '+15555550142' },
  problem: 'The kitchen sink is leaking.',
  accessNotes: 'Gate code 4B',
  urgency: 'normal',
};

describe('dispatch address', () => {
  it('formats and reads back the unit', () => {
    expect(formatAddress(ADDRESS)).toBe('123 Main St, Apt 4B, Springfield, IL 62701');
    expect(formatAddress({ ...ADDRESS, unit: undefined })).toBe('123 Main St, Springfield, IL 62701');
  });

  it('normalizes case, punctuation and spacing, and keeps units distinct', () => {
    expect(normalizeAddress(ADDRESS)).toBe(normalizeAddress({ ...ADDRESS, line1: '123 MAIN ST.', city: 'springfield' }));
    expect(normalizeAddress(ADDRESS)).not.toBe(normalizeAddress({ ...ADDRESS, unit: 'Apt 3A' }));
  });
});

describe('spoken dispatch window', () => {
  it('quotes a range, never an exact time, in English and Spanish', () => {
    const en = spokenWindow(WINDOW, NOW, TZ, 'en');
    const es = spokenWindow(WINDOW, NOW, TZ, 'es');
    expect(en).toMatch(/tomorrow between .+ and .+/i);
    expect(en).not.toMatch(/\bat\b/i);
    expect(es).toMatch(/mañana entre .+ y .+/i);
    expect(es).not.toMatch(/\ba las\b/i);
  });

  it('names a weekday when the window is later in the week', () => {
    const thu = { start: '2026-10-22T13:00:00-04:00', end: '2026-10-22T17:00:00-04:00' };
    expect(spokenWindow(thu, NOW, TZ, 'en')).toMatch(/^Thursday between /);
  });
});

describe('create-job readback', () => {
  it('includes the unit, the spoken window, and the last four of the phone (EN + ES)', () => {
    const en = createJobReadback(INPUT, NOW, TZ, 'en');
    const es = createJobReadback({ ...INPUT, urgency: 'urgent' }, NOW, TZ, 'es');
    expect(en).toContain('123 Main St, Apt 4B, Springfield, IL 62701');
    expect(en).toContain('phone ending in 0142');
    expect(en).toMatch(/a plumbing job at/);
    expect(en).not.toMatch(/\bat 1(?::00)?\s*(AM|PM)/i);
    expect(es).toContain('Apt 4B');
    expect(es).toMatch(/un trabajo urgente de plumbing/);
    expect(es).toContain('teléfono que termina en 0142');
  });
});
