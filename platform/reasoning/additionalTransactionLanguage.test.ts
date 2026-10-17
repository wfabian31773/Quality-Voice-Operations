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
  });

  it('detects an explicit extra booking in Spanish', () => {
    expect(isAdditionalTransactionRequest('puedo reservar otra cita')).toBe(true);
    expect(isAdditionalTransactionRequest('quiero reservar también')).toBe(true);
    expect(isAdditionalTransactionRequest('una más por favor')).toBe(true);
    expect(isAdditionalTransactionRequest('una mas por favor')).toBe(true);
    expect(isAdditionalTransactionRequest('para mi hijo')).toBe(true);
    expect(isAdditionalTransactionRequest('para mi hija')).toBe(true);
  });

  it('does not treat thanks, confirmations, or goodbyes as a new booking', () => {
    expect(isAdditionalTransactionRequest('thanks for booking my appointment')).toBe(false);
    expect(isAdditionalTransactionRequest('yes, cancel that haircut')).toBe(false);
    expect(isAdditionalTransactionRequest('yes that is all, goodbye')).toBe(false);
    expect(isAdditionalTransactionRequest('ok thanks')).toBe(false);
  });
});
