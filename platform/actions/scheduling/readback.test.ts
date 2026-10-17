import { describe, expect, it } from 'vitest';
import {
  bookingPriceText,
  bookReadback,
  cancellationPolicyText,
  intlLocale,
  phoneLast4,
  readbackLang,
  toE164,
} from './readback';

describe('toE164', () => {
  it.each([
    ['(555) 555-0142', '+15555550142'],
    ['555.555.0142', '+15555550142'],
    ['1 555 555 0142', '+15555550142'],
    ['+1 555-555-0142', '+15555550142'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalizes %s', (raw, e164) => {
    expect(toE164(raw)).toBe(e164);
  });

  it.each(['12345', '055-555-0142', '+0123456789', '+1234567890123456', 'call me'])('rejects %s', (raw) => {
    expect(toE164(raw)).toBeNull();
  });

  it('keeps the last four digits for the readback', () => {
    expect(phoneLast4('+15555550142')).toBe('0142');
  });
});

describe('locales', () => {
  it('reads back in Spanish for es*, English otherwise (no tenant locale yet)', () => {
    expect(readbackLang('es')).toBe('es');
    expect(readbackLang('es-MX')).toBe('es');
    expect(readbackLang('en-US')).toBe('en');
    expect(readbackLang('vi')).toBe('en');
    expect(readbackLang(undefined)).toBe('en');
    expect(intlLocale('es')).toBe('es-US');
    expect(intlLocale('es-MX')).toBe('es-MX');
    expect(intlLocale(undefined)).toBe('en-US');
    expect(intlLocale('vi')).toBe('en-US');
  });
});

describe('readbacks', () => {
  const facts = { serviceNames: ['Gel manicure', 'Gel removal'], staffName: 'Rosa', when: 'Thursday at 1 PM', customerName: 'Mai', phone: '+15555550199' };
  const priced = [
    { priceKind: 'from' as const, priceCents: 4500, priceMaxCents: null },
    { priceKind: 'fixed' as const, priceCents: 1000, priceMaxCents: null },
  ];

  it('builds the English and Spanish book readbacks with price text', () => {
    expect(bookReadback(facts, bookingPriceText(priced, 'en'), 'en')).toBe(
      'Gel manicure and Gel removal with Rosa, Thursday at 1 PM, for Mai, phone ending in 0199. The price is from $45 plus $10.',
    );
    expect(bookReadback({ ...facts, when: 'jueves, 1 p. m.' }, bookingPriceText(priced, 'es'), 'es')).toBe(
      'Gel manicure y Gel removal con Rosa, jueves, 1 p. m., para Mai, teléfono que termina en 0199. El precio es desde $45 más $10.',
    );
  });

  it('says the shop will confirm the price when any service is unpriced', () => {
    const unpriced = [...priced, { priceKind: 'hidden' as const, priceCents: null, priceMaxCents: null }];
    expect(bookingPriceText(unpriced, 'en')).toBeNull();
    expect(bookReadback(facts, null, 'en')).toMatch(/The shop will confirm the price\.$/);
    expect(bookReadback(facts, null, 'es')).toMatch(/El negocio le confirmará el precio\.$/);
  });

  it('states the cancellation policy in both languages', () => {
    expect(cancellationPolicyText(1, 'en')).toMatch(/at least 1 hour's notice/);
    expect(cancellationPolicyText(48, 'es')).toMatch(/al menos 48 horas de aviso/);
  });
});
