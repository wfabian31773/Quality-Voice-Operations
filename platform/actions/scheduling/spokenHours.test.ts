import { describe, expect, it } from 'vitest';
import { spokenHours, spokenWeek } from './spokenHours';

describe('spokenHours', () => {
  it('says whole hours on a 12-hour clock', () => {
    expect(spokenHours('09:00-17:00', 'en')).toBe('9 AM to 5 PM');
    expect(spokenHours('09:00-17:00', 'es')).toBe('9 a. m. a 5 p. m.');
  });

  it('keeps the minutes of a half hour', () => {
    expect(spokenHours('09:30-17:30', 'en')).toBe('9:30 AM to 5:30 PM');
    expect(spokenHours('09:30-17:30', 'es')).toBe('9:30 a. m. a 5:30 p. m.');
    expect(spokenHours('00:30-12:30', 'en')).toBe('12:30 AM to 12:30 PM');
  });

  it('says noon and midnight (00:00 and 24:00) by name', () => {
    expect(spokenHours('12:00-24:00', 'en')).toBe('noon to midnight');
    expect(spokenHours('12:00-24:00', 'es')).toBe('12 del mediodía a 12 de la noche');
    expect(spokenHours('00:00-06:00', 'en')).toBe('midnight to 6 AM');
  });

  it('says a shift past midnight and a split day', () => {
    expect(spokenHours('22:00-02:00', 'en')).toBe('10 PM to 2 AM');
    expect(spokenHours('09:00-12:00, 13:00-16:00', 'en')).toBe('9 AM to noon and 1 PM to 4 PM');
    expect(spokenHours('09:00-12:00, 13:00-16:00', 'es')).toBe('9 a. m. a 12 del mediodía y 1 p. m. a 4 p. m.');
  });

  it('is null for a day with no hours, or text that is not clock times', () => {
    expect(spokenHours(undefined, 'en')).toBeNull();
    expect(spokenHours('', 'en')).toBeNull();
    expect(spokenHours('closed', 'en')).toBeNull();
    expect(spokenHours('09:00-25:00', 'en')).toBeNull();
    expect(spokenHours('24:30-02:00', 'en')).toBeNull();
  });

  it('spokenWeek words each day with hours and leaves an off day out', () => {
    expect(spokenWeek({ tue: '09:00-17:00', wed: '', sat: '10:00-14:30' }, 'en')).toEqual({ tue: '9 AM to 5 PM', sat: '10 AM to 2:30 PM' });
  });
});
