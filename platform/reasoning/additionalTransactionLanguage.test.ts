import { describe, expect, it } from 'vitest';
import { isAdditionalTransactionRequest } from './additionalTransactionLanguage';

describe('additional transaction language', () => {
  it('detects an explicit extra booking in English', () => {
    expect(isAdditionalTransactionRequest('can I book another appointment')).toBe(true);
    expect(isAdditionalTransactionRequest('I also book one for Friday')).toBe(true);
    expect(isAdditionalTransactionRequest('one more haircut please')).toBe(true);
    expect(isAdditionalTransactionRequest('I need a second appointment')).toBe(true);
    expect(isAdditionalTransactionRequest('book one for my son too')).toBe(true);
    expect(isAdditionalTransactionRequest('book for my daughter')).toBe(true);
    expect(isAdditionalTransactionRequest('book for my friend')).toBe(true);
    expect(isAdditionalTransactionRequest('Can you book a pedicure too?')).toBe(true);
    expect(isAdditionalTransactionRequest('book a color as well')).toBe(true);
    expect(isAdditionalTransactionRequest('one more for my son')).toBe(true);
    expect(isAdditionalTransactionRequest('one for my daughter too')).toBe(true);
  });

  it('detects an explicit extra booking in Spanish', () => {
    expect(isAdditionalTransactionRequest('puedo reservar otra cita')).toBe(true);
    expect(isAdditionalTransactionRequest('quiero reservar también')).toBe(true);
    expect(isAdditionalTransactionRequest('una más por favor')).toBe(true);
    expect(isAdditionalTransactionRequest('una mas por favor')).toBe(true);
    expect(isAdditionalTransactionRequest('para mi hijo')).toBe(true);
    expect(isAdditionalTransactionRequest('para mi hija')).toBe(true);
    expect(isAdditionalTransactionRequest('otra para mi hija')).toBe(true);
  });

  it('does not treat thanks, confirmations, or polite closings as a new booking', () => {
    expect(isAdditionalTransactionRequest('thanks for booking my appointment')).toBe(false);
    expect(isAdditionalTransactionRequest('yes, cancel that haircut')).toBe(false);
    expect(isAdditionalTransactionRequest('yes that is all, goodbye')).toBe(false);
    expect(isAdditionalTransactionRequest('ok thanks')).toBe(false);
    expect(isAdditionalTransactionRequest('Thanks, you too')).toBe(false);
    expect(isAdditionalTransactionRequest('you too, bye')).toBe(false);
    expect(isAdditionalTransactionRequest('igualmente')).toBe(false);
    expect(isAdditionalTransactionRequest('gracias, usted también')).toBe(false);
  });

  it('does not treat negated declines as an extra booking', () => {
    expect(isAdditionalTransactionRequest("I don't need another appointment")).toBe(false);
    expect(isAdditionalTransactionRequest('I do not want another appointment')).toBe(false);
    expect(isAdditionalTransactionRequest("Don't book another appointment")).toBe(false);
    expect(isAdditionalTransactionRequest("I don't want to book another appointment")).toBe(false);
    expect(isAdditionalTransactionRequest('no need for another')).toBe(false);
    expect(isAdditionalTransactionRequest('no other')).toBe(false);
    expect(isAdditionalTransactionRequest('no quiero otra cita')).toBe(false);
    expect(isAdditionalTransactionRequest('no necesito otra')).toBe(false);
    expect(isAdditionalTransactionRequest('no me reserve otra cita')).toBe(false);
    expect(isAdditionalTransactionRequest('no quiero reservar otra')).toBe(false);
  });
});
