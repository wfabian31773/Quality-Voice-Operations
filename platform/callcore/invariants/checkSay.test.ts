import { describe, expect, it } from 'vitest';
import { checkSay } from './checks';
import { createCallFacts, onPrepared, onExplicitYes, onSpeakableNumber, onToolResult } from './facts';
import { INSTRUCTIONS } from './instructions';
import { STAGE_DIRECTION_WORDS, SUCCESS_CLAIMS, TEXT_PROMISE_PHRASES, TRANSFER_PHRASES } from './phrases';
import type { CallFacts, CallFactsInit } from './types';

const BOOK_COMMIT = 'scheduling.book.commit';
const CANCEL_COMMIT = 'scheduling.cancel.commit';
const RESCHEDULE_COMMIT = 'scheduling.reschedule.commit';
const TICKET_COMMIT = 'tickets.create.commit';
const SMS_SEND = 'sms.send';
const TRANSFER = 'call.transfer';

function facts(over: Partial<CallFactsInit> = {}): CallFacts {
  return createCallFacts({
    callId: 'CA-test',
    transferNumberConfigured: false,
    voiceRefs: false,
    smsEnabled: false,
    allowedActions: [BOOK_COMMIT, TICKET_COMMIT, SMS_SEND, TRANSFER],
    ...over,
  });
}

function committed(f: CallFacts, action: string, ok: boolean, refs: string[] = [], token = 'tok-1'): CallFacts {
  const prepared = onExplicitYes(onPrepared(f, token), token);
  return onToolResult(prepared, { action, kind: 'commit', ok, refs, confirmationToken: token });
}

function expectBlocked(result: ReturnType<typeof checkSay>, rule: keyof typeof INSTRUCTIONS) {
  expect(result).toEqual({ ok: false, rule, instruction: INSTRUCTIONS[rule] });
}

describe('checkSay (a) success words need a matching ok commit', () => {
  it("EN: \"you're booked\" before commit is blocked, after an ok commit it is allowed", () => {
    const line = "Great, you're booked with Marcus Friday at nine.";
    expectBlocked(checkSay(facts(), line), 'say.success_before_commit');
    expect(checkSay(committed(facts(), BOOK_COMMIT, true), line)).toEqual({ ok: true });
  });

  it('ES: "está reservada" / "ya quedó" before commit are blocked, after an ok commit allowed', () => {
    for (const line of ['Listo, su cita está reservada para el viernes.', '¡Ya quedó!']) {
      expectBlocked(checkSay(facts(), line), 'say.success_before_commit');
      expect(checkSay(committed(facts(), BOOK_COMMIT, true), line)).toEqual({ ok: true });
    }
  });

  it('a failed commit does not allow success words; the latest matching result decides', () => {
    expectBlocked(checkSay(committed(facts(), BOOK_COMMIT, false), "You're all set."), 'say.success_before_commit');
    const okThenFail = committed(committed(facts(), BOOK_COMMIT, true, [], 'tok-1'), BOOK_COMMIT, false, [], 'tok-2');
    expectBlocked(checkSay(okThenFail, "You're booked for three."), 'say.success_before_commit');
  });

  it('a claim must match the kind of commit: a booking does not cover "I\'ve sent" or "I\'ve let them know"', () => {
    const afterBooking = committed(facts(), BOOK_COMMIT, true);
    expectBlocked(checkSay(afterBooking, "I've sent you the details."), 'say.success_before_commit');
    expectBlocked(checkSay(afterBooking, "I've let them know you called."), 'say.success_before_commit');
    expectBlocked(checkSay(afterBooking, 'Ya les avisé.'), 'say.success_before_commit');
    const afterSms = onToolResult(afterBooking, { action: SMS_SEND, kind: 'write', ok: true });
    expect(checkSay(afterSms, "I've sent you the details.")).toEqual({ ok: true });
    const afterTicket = committed(afterBooking, TICKET_COMMIT, true, [], 'tok-2');
    expect(checkSay(afterTicket, "I've let them know you called.")).toEqual({ ok: true });
    expect(checkSay(afterTicket, 'Ya les avisé.')).toEqual({ ok: true });
  });

  it('cancellation claims need a cancel commit', () => {
    expectBlocked(checkSay(committed(facts(), BOOK_COMMIT, true), "I've cancelled it."), 'say.success_before_commit');
    expect(checkSay(committed(facts(), CANCEL_COMMIT, true), "I've cancelled it.")).toEqual({ ok: true });
    expect(checkSay(committed(facts(), CANCEL_COMMIT, true), 'Ya la cancelé.')).toEqual({ ok: true });
  });

  it('normalizes case, curly apostrophes and diacritics; matches whole words only', () => {
    expectBlocked(checkSay(facts(), 'YOU’RE BOOKED'), 'say.success_before_commit');
    expectBlocked(checkSay(facts(), 'Su cita esta reservada.'), 'say.success_before_commit');
    expect(checkSay(facts(), "You're not booked yet. Which day works?")).toEqual({ ok: true });
    expect(checkSay(facts(), 'I have bookings open Friday.')).toEqual({ ok: true });
  });

  it('ES: "ya está reservado" describing a taken slot is allowed before a commit', () => {
    expect(checkSay(facts(), 'Lo siento, a las 3 ya está reservado.')).toEqual({ ok: true });
    expect(checkSay(facts(), 'Ese horario ya está reservado, ¿le sirve a las 4?')).toEqual({ ok: true });
    expect(checkSay(facts(), 'La cita del martes está cancelada.')).toEqual({ ok: true });
  });

  it('ES: anchored booking confirmations are still blocked before a commit', () => {
    for (const line of [
      'Su cita está reservada para el viernes.',
      'Su cita ya está reservada.',
      'Listo, ya está reservada su cita.',
      'Le quedó reservada para las 3.',
    ]) {
      expectBlocked(checkSay(facts(), line), 'say.success_before_commit');
    }
    for (const line of ['Su cita está cancelada.', 'Ya está cancelada su cita.']) {
      expectBlocked(checkSay(facts(), line), 'say.success_before_commit');
      expect(checkSay(committed(facts(), CANCEL_COMMIT, true), line)).toEqual({ ok: true });
    }
  });

  it('a versioned action name (booking.book@1) matches its claim group', () => {
    expectBlocked(checkSay(committed(facts(), 'booking.book@1', false), "You're booked."), 'say.success_before_commit');
    expect(checkSay(committed(facts(), 'booking.book@1', true), "You're booked.")).toEqual({ ok: true });
  });

  it('every listed success phrase is blocked with no commit', () => {
    for (const group of SUCCESS_CLAIMS) {
      for (const phrase of group.phrases) {
        expect(checkSay(facts(), phrase), phrase).toMatchObject({ ok: false, rule: 'say.success_before_commit' });
      }
    }
  });

  it('readback labels "Confirmed:" / "Confirmado:" are blocked before a commit, allowed after an ok booking commit', () => {
    for (const line of [
      "Confirmed: Men's cut with Marco, Friday at 3, for Ana.",
      'Confirmado: corte con Marco, el viernes a las 3, para Ana.',
      'Perfect. Confirmed: Friday at 3 with Marco.',
      'Perfect, confirmed: Friday at 3 with Marco.',
      'Marco, confirmed: Friday at 3.',
      'Ana, confirmado: el viernes a las 3.',
      'CONFIRMADO : corte con Marco.',
    ]) {
      expectBlocked(checkSay(facts(), line), 'say.success_before_commit');
      expectBlocked(checkSay(committed(facts(), BOOK_COMMIT, false), line), 'say.success_before_commit');
      expect(checkSay(committed(facts(), BOOK_COMMIT, true), line), line).toEqual({ ok: true });
    }
  });

  it('confirm-words that are not an opening label are allowed before a commit', () => {
    for (const line of [
      'Just to confirm: Friday at 3 with Marco, is that right?',
      'I confirmed your phone number.',
      '¿Me confirma su nombre?',
      'Marco confirmed: Friday works.',
      'Once it is confirmed, I will let you know.',
    ]) {
      expect(checkSay(facts(), line), line).toEqual({ ok: true });
    }
  });

  it('readback labels "Cancelled:" / "Cancelada:" need an ok cancel commit; a booking commit does not count', () => {
    for (const line of ["Cancelled: Ana's men's cut with Marco, Friday at 3.", 'Cancelada: la cita de Ana, corte con Marco, el viernes.']) {
      expectBlocked(checkSay(facts(), line), 'say.success_before_commit');
      expectBlocked(checkSay(committed(facts(), BOOK_COMMIT, true), line), 'say.success_before_commit');
      expect(checkSay(committed(facts(), CANCEL_COMMIT, true), line), line).toEqual({ ok: true });
    }
  });

  it('readback labels "Done:" / "Listo:" are blocked before a commit, allowed after an ok reschedule or booking commit', () => {
    for (const line of [
      "Done: Ana's men's cut is now Friday at 3 with Marco.",
      'Listo: la cita de Ana, corte, ahora es el viernes con Marco.',
    ]) {
      expectBlocked(checkSay(facts(), line), 'say.success_before_commit');
      expect(checkSay(committed(facts(), RESCHEDULE_COMMIT, true), line), line).toEqual({ ok: true });
      expect(checkSay(committed(facts(), BOOK_COMMIT, true), line), line).toEqual({ ok: true });
    }
  });

  it('"done" / "listo" that are not an opening label are allowed before a commit', () => {
    for (const line of [
      'Once we are done: Friday at 3 works.',
      'Let me know when you are done, then I can check Friday.',
      '¿Está listo para reservar?',
      '¿Está listo para reservar? Opciones: viernes a las 3.',
    ]) {
      expect(checkSay(facts(), line), line).toEqual({ ok: true });
    }
  });

  it('every listed label is blocked with no commit', () => {
    for (const group of SUCCESS_CLAIMS) {
      for (const label of group.labels ?? []) {
        expect(checkSay(facts(), `${label}: Friday at 3.`), label).toMatchObject({ ok: false, rule: 'say.success_before_commit' });
      }
    }
  });
});

describe('checkSay (b) voiceRefs:false blocks every ref-shaped string', () => {
  it('voiceRefs:false: "your confirmation is BK-4712" is blocked even though the tool returned BK-4712', () => {
    const f = committed(facts({ voiceRefs: false }), BOOK_COMMIT, true, ['BK-4712']);
    expectBlocked(checkSay(f, 'You are booked, your confirmation is BK-4712.'), 'say.ref_not_voiced');
  });

  it('blocks spaced, dashed, joined, spelled and spoken-digit forms, EN and ES', () => {
    const f = committed(facts(), BOOK_COMMIT, true, ['BK-4712']);
    for (const line of [
      'Your ref is BK 4712.',
      'Your ref is bk4712.',
      'That is B K 4 7 1 2.',
      'That is B-K-four-seven-one-two.',
      'Your number is 4 7 1 2 5.',
      'Your number is 47125.',
      'Su número de confirmación es BK-4712.',
      'Es B K cuatro siete uno dos.',
    ]) {
      expectBlocked(checkSay(f, line), 'say.ref_not_voiced');
    }
  });

  it('allows ordinary times, prices, dates and counts', () => {
    const f = committed(facts(), BOOK_COMMIT, true, ['BK-4712']);
    expect(
      checkSay(f, "You're booked with Marcus on October 17, 2026 at 9:30, it's $25. A text will follow once texting is enabled."),
    ).toEqual({ ok: true });
    expect(checkSay(f, 'Quedó reservada el viernes a las 10:30, son 25 dólares.')).toEqual({ ok: true });
    expect(checkSay(f, 'There are 2 openings at 3 and 4.')).toEqual({ ok: true });
  });

  it('allows dates in every common written form, EN and ES', () => {
    for (const date of [
      'October 17 2026',
      'Oct 17, 2026',
      'Oct. 17th 2026',
      '17 October 2026',
      '10 17 2026',
      '10/17/2026',
      '10-17-2026',
      '17/10/2026',
      '2026-10-17',
      '17 de octubre de 2026',
      '17 oct 2026',
    ]) {
      expect(checkSay(facts(), `Your visit is on ${date} at 3.`), date).toEqual({ ok: true });
    }
  });

  it('still blocks real refs, alone and next to a date', () => {
    const f = facts({ speakableNumbers: ['512-555-0199'] });
    for (const line of [
      'Your ref is BK-4712.',
      'Your code is A1B2C3.',
      'Your number is 48213.',
      'Your code is four eight two one three.',
      'Su código es cuatro ocho dos uno tres.',
      'Call us at 512-555-0100.',
      'On October 17 2026 your ref is 48213.',
      'Your ref is 48213, 10/17/2026.',
      'Call 555 10 17 2026.',
      'Your code is 4 8 2 1 3 may I help you?',
    ]) {
      expectBlocked(checkSay(f, line), 'say.ref_not_voiced');
    }
  });

  it('phone readback: "I have your number as 512-555-0199" is allowed when listed, blocked when not', () => {
    const line = 'I have your number as 512-555-0199.';
    expect(checkSay(facts({ speakableNumbers: ['512-555-0199'] }), line)).toEqual({ ok: true });
    expect(checkSay(onSpeakableNumber(facts(), '512 555 0199'), line)).toEqual({ ok: true });
    expectBlocked(checkSay(facts(), line), 'say.ref_not_voiced');
    expectBlocked(checkSay(facts({ speakableNumbers: ['512-555-0100'] }), line), 'say.ref_not_voiced');
    expectBlocked(checkSay(facts({ voiceRefs: true }), line), 'say.ref_not_committed');
    expect(checkSay(facts({ voiceRefs: true, speakableNumbers: ['5125550199'] }), line)).toEqual({ ok: true });
  });

  it('phone readback in spoken digits is allowed when the number is listed', () => {
    const en = 'I have five one two five five five zero one nine nine.';
    const es = 'Tengo cinco uno dos cinco cinco cinco cero uno nueve nueve.';
    const f = facts({ speakableNumbers: ['512-555-0199'] });
    expect(checkSay(f, en)).toEqual({ ok: true });
    expect(checkSay(f, es)).toEqual({ ok: true });
    expectBlocked(checkSay(facts(), en), 'say.ref_not_voiced');
    expectBlocked(checkSay(facts(), es), 'say.ref_not_voiced');
  });

  it('a listed phone number does not let BK-4712 through', () => {
    const f = committed(facts({ speakableNumbers: ['512-555-0199'] }), BOOK_COMMIT, true, ['BK-4712']);
    expectBlocked(checkSay(f, 'Your confirmation is BK-4712.'), 'say.ref_not_voiced');
    expectBlocked(checkSay(f, 'Your number is 512-555-0199 and your ref is BK-4712.'), 'say.ref_not_voiced');
  });

  it('the instruction never echoes the ref', () => {
    const r = checkSay(facts(), 'Your confirmation is BK-4712.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.instruction).not.toContain('4712');
  });
});

describe('checkSay (c) voiceRefs:true allows only committed refs', () => {
  const voiced = () => facts({ voiceRefs: true });

  it('allows a ref equal to a committed ok ref, in any spacing or case', () => {
    const f = committed(voiced(), BOOK_COMMIT, true, ['BK-4712']);
    expect(checkSay(f, 'Your confirmation is BK-4712.')).toEqual({ ok: true });
    expect(checkSay(f, 'Your confirmation is BK 4712.')).toEqual({ ok: true });
    expect(checkSay(f, 'Su confirmación es B K cuatro siete uno dos.')).toEqual({ ok: true });
  });

  it('blocks an invented ref, a ref before commit, and a ref from a failed commit', () => {
    const f = committed(voiced(), BOOK_COMMIT, true, ['BK-4712']);
    expectBlocked(checkSay(f, 'Your confirmation is BK-4713.'), 'say.ref_not_committed');
    expectBlocked(checkSay(f, 'Your number is 47125.'), 'say.ref_not_committed');
    expectBlocked(checkSay(voiced(), 'Your confirmation is BK-4712.'), 'say.ref_not_committed');
    expectBlocked(checkSay(committed(voiced(), BOOK_COMMIT, false, ['BK-4712']), 'It is BK-4712.'), 'say.ref_not_committed');
  });
});

describe('checkSay (d) transfer words need an ok transfer result', () => {
  it('EN: "connecting you" with no transfer is blocked, after an ok transfer allowed', () => {
    expectBlocked(checkSay(facts(), 'Connecting you now.'), 'say.transfer_without_result');
    const transferred = onToolResult(facts({ transferNumberConfigured: true }), { action: TRANSFER, kind: 'transfer', ok: true });
    expect(checkSay(transferred, 'Connecting you now.')).toEqual({ ok: true });
  });

  it('ES: "le comunico" / "lo transfiero" blocked without a transfer, allowed after one', () => {
    const transferred = onToolResult(facts(), { action: TRANSFER, kind: 'transfer', ok: true });
    for (const line of ['Le comunico con el encargado.', 'Lo transfiero ahora.']) {
      expectBlocked(checkSay(facts(), line), 'say.transfer_without_result');
      expect(checkSay(transferred, line)).toEqual({ ok: true });
    }
  });

  it('a failed transfer, or only a booking commit, does not allow transfer words', () => {
    const failed = onToolResult(facts(), { action: TRANSFER, kind: 'transfer', ok: false });
    expectBlocked(checkSay(failed, 'Let me transfer you.'), 'say.transfer_without_result');
    expectBlocked(checkSay(committed(facts(), BOOK_COMMIT, true), 'Transferring you.'), 'say.transfer_without_result');
  });

  it('every listed transfer phrase is blocked with no transfer', () => {
    for (const phrase of TRANSFER_PHRASES) {
      expect(checkSay(facts(), phrase), phrase).toMatchObject({ ok: false, rule: 'say.transfer_without_result' });
    }
  });
});

describe('checkSay (e) stage directions', () => {
  it('blocks narration words and bracketed narration, EN and ES', () => {
    for (const line of [
      'Filing quietly.',
      '(pause) Okay, Friday works.',
      '*files the ticket* Done.',
      '[typing] One moment.',
      '{beat} Sure.',
      'Lo anoto en silencio.',
      '(pausa) Muy bien.',
    ]) {
      expectBlocked(checkSay(facts(), line), 'say.stage_direction');
    }
    for (const word of STAGE_DIRECTION_WORDS) {
      expect(checkSay(facts(), word), word).toMatchObject({ ok: false, rule: 'say.stage_direction' });
    }
  });

  it('allows plain speech', () => {
    expect(checkSay(facts(), 'Sure, one moment while I check Friday.')).toEqual({ ok: true });
    expect(checkSay(facts(), 'Claro, un momento mientras reviso el viernes.')).toEqual({ ok: true });
  });
});

describe('checkSay (f) text promises with SMS off', () => {
  it('EN: "I\'ll text you" is blocked with SMS off; "a text will follow once texting is enabled" is allowed', () => {
    expectBlocked(checkSay(facts(), "I'll text you the details."), 'say.text_promise_sms_off');
    expectBlocked(checkSay(facts(), 'A text will follow.'), 'say.text_promise_sms_off');
    expect(checkSay(facts(), 'A text will follow once texting is enabled.')).toEqual({ ok: true });
  });

  it('ES: blocked without the qualifier, allowed with it', () => {
    expectBlocked(checkSay(facts(), 'Le llegará un mensaje con los detalles.'), 'say.text_promise_sms_off');
    expect(
      checkSay(facts(), 'Le llegará un mensaje cuando se activen los mensajes de texto.'),
    ).toEqual({ ok: true });
  });

  it('a qualifier only covers a text promise in its own sentence', () => {
    expectBlocked(
      checkSay(facts(), "I'll text you now; once texting is enabled, we'll send the receipt."),
      'say.text_promise_sms_off',
    );
    expectBlocked(
      checkSay(facts(), "I'll text you the confirmation. Once texting is enabled, you'll get a text too."),
      'say.text_promise_sms_off',
    );
    expect(checkSay(facts(), "Once texting is enabled, I'll text you the details.")).toEqual({ ok: true });
    expect(checkSay(facts(), "I'll text you once texting is enabled.")).toEqual({ ok: true });
    expect(
      checkSay(facts(), 'Cuando se activen los mensajes de texto, le enviaré un mensaje.'),
    ).toEqual({ ok: true });
  });

  it('SMS on: a text promise is allowed', () => {
    expect(checkSay(facts({ smsEnabled: true }), "I'll text you the details.")).toEqual({ ok: true });
  });

  it('every listed text promise is blocked with SMS off', () => {
    for (const phrase of TEXT_PROMISE_PHRASES) {
      expect(checkSay(facts(), phrase), phrase).toMatchObject({ ok: false, rule: 'say.text_promise_sms_off' });
    }
  });
});
