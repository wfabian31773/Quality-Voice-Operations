import { describe, expect, it } from 'vitest';
import { findStageDirections } from '../../agent-runtime/promptLint';
import { CONTRACTS, contractKey } from '../../callcore/contracts';
import {
  checkSay,
  createCallFacts,
  findRefs,
  normalizeSpeech,
  onExplicitYes,
  onPrepared,
  onToolResult,
  SMS_OFF_QUALIFIERS,
  STAGE_DIRECTION_PATTERNS,
  STAGE_DIRECTION_WORDS,
  TEXT_PROMISE_PHRASES,
  type CallFacts,
} from '../../callcore/invariants';
import {
  BARBERSHOP_TEMPLATE_V1,
  TEMPLATE_LANGUAGES,
  fillPlaceholders,
  phraseAsk,
  templateKey,
  type Phrase,
  type TemplateLanguage,
} from './index';

const T = BARBERSHOP_TEMPLATE_V1;

// Derived from the contracts, so an askId added to any contract later fails here until it is phrased.
const CONTRACT_ASK_IDS = [...new Set(CONTRACTS.flatMap((c) => c.slots.map((s) => s.askId)))];

/**
 * Commit `readback` strings in the shape platform/actions/scheduling/readback.ts
 * returns (confirmedReadback / rescheduledReadback / cancelledReadback), with
 * the time worded by spokenSlot (en-US, es-US). None carries a booking id.
 */
const SAMPLE_READBACK = {
  booked: {
    en: "Confirmed: Men's cut with Marco, Friday at 3:30 PM, for Luis.",
    es: 'Confirmado: Corte de caballero con Marco, viernes, 3:30 p. m., para Luis.',
  },
  rescheduled: {
    en: "Done: Luis's Men's cut is now Tuesday, October 27 at 3:30 PM with Marco.",
    es: 'Listo: la cita de Luis, Corte de caballero, ahora es martes, 27 de octubre, 3:30 p. m. con Marco.',
  },
  cancelled: {
    en: "Cancelled: Luis's Men's cut with Marco, Friday at 3:30 PM.",
    es: 'Cancelada: la cita de Luis, Corte de caballero con Marco, viernes, 3:30 p. m.',
  },
} as const;

type WriteKey = keyof typeof SAMPLE_READBACK;

/** An after-write line as it would be spoken: the server readback filled in. */
function spokenAfterWrite(key: WriteKey, lang: TemplateLanguage): string {
  return fillPlaceholders(T.afterWrite[key][lang], { readback: SAMPLE_READBACK[key][lang] });
}

/**
 * Everything the template holds, as [label, text] pairs, both languages, with
 * placeholders filled as they would be before speaking ("{{readback}}" would
 * otherwise read as bracketed narration).
 */
function allTexts(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (label: string, phrase: Phrase) => {
    for (const lang of TEMPLATE_LANGUAGES) out.push([`${label}.${lang}`, phrase[lang]]);
  };
  add('persona', T.persona);
  for (const lang of TEMPLATE_LANGUAGES) {
    out.push([`greeting.${lang}`, fillPlaceholders(T.greeting[lang], { businessName: 'Sharp Line Barbers' })]);
  }
  for (const [askId, phrase] of Object.entries(T.asks)) add(askId, phrase);
  add('afterWrite.textWillFollow', T.afterWrite.textWillFollow);
  for (const key of Object.keys(SAMPLE_READBACK) as WriteKey[]) {
    for (const lang of TEMPLATE_LANGUAGES) out.push([`afterWrite.${key}.${lang}`, spokenAfterWrite(key, lang)]);
  }
  return out;
}

const REF_PHRASING: readonly RegExp[] = [
  /\byour\s+(?:confirmation|reference|ref|booking|appointment|ticket)\s+(?:number|code|id)\b/i,
  /\b(?:confirmation|reference|booking|appointment|ticket)\s+(?:number|code|id)\s+(?:is|will be)\b/i,
  /\b(?:su|tu)\s+(?:número|codigo|código)\s+de\s+(?:confirmación|reserva|referencia|cita|ticket)\b/i,
  /\b(?:número|código)\s+de\s+(?:confirmación|reserva|referencia|cita|ticket)\s+es\b/i,
];

const STAGE_WORDS = STAGE_DIRECTION_WORDS.map(normalizeSpeech);

function stageDirectionIssues(text: string): string[] {
  const issues = findStageDirections(text).map((h) => `${h.rule}: ${h.match}`);
  for (const re of STAGE_DIRECTION_PATTERNS) {
    const m = text.match(re);
    if (m) issues.push(`pattern: ${m[0]}`);
  }
  const norm = ` ${normalizeSpeech(text)} `;
  for (const w of STAGE_WORDS) if (norm.includes(` ${w} `)) issues.push(`word: ${w}`);
  return issues;
}

function facts(): CallFacts {
  return createCallFacts({
    callId: 'CA-barbershop-template',
    transferNumberConfigured: false,
    voiceRefs: false,
    smsEnabled: false,
    allowedActions: [],
  });
}

function committed(action: string): CallFacts {
  const f = onExplicitYes(onPrepared(facts(), 'tok-1'), 'tok-1');
  return onToolResult(f, { action, kind: 'commit', ok: true, refs: [], confirmationToken: 'tok-1' });
}

describe('barbershop@1 template export', () => {
  it('is versioned and pins exactly the exported contracts', () => {
    expect(templateKey(T)).toBe('barbershop@1');
    expect(T.languages).toEqual(['en', 'es']);
    expect([...T.contracts].sort()).toEqual(CONTRACTS.map(contractKey).sort());
  });

  it('answers hours and services from the business details, never a tool that does not exist', () => {
    for (const lang of TEMPLATE_LANGUAGES) {
      expect(T.persona[lang]).not.toMatch(/business[._]get_info|get_info/);
      // No tool name of any kind: the persona's tools come from the composer.
      expect(T.persona[lang]).not.toMatch(/\b[a-z][a-z0-9]+(?:[._][a-z0-9]+)+\b/);
    }
    expect(T.persona.en).toMatch(/answer only from the business details/i);
    expect(T.persona.en).toMatch(/never guess/i);
    expect(T.persona.en).toMatch(/you'll have the shop confirm it/i);
    expect(T.persona.es).toMatch(/conteste solo con los datos del negocio/i);
    expect(T.persona.es).toMatch(/nunca los adivine/i);
    expect(T.persona.es).toMatch(/la barbería se lo va a confirmar/i);
  });

  it("takes a barber's working days from the staff list, not the prompt", () => {
    expect(T.persona.en).toMatch(/working days the staff list gives you, never these instructions/i);
    expect(T.persona.es).toMatch(/días de trabajo que da la lista del personal, nunca estas instrucciones/i);
  });

  it('greets with the shop name in both languages', () => {
    for (const lang of TEMPLATE_LANGUAGES) {
      expect(T.greeting[lang]).toContain('{{businessName}}');
      expect((T.greeting[lang].match(/\?/g) ?? []).length).toBe(1);
    }
  });

  it('persona asks one question at a time and has the barbershop register', () => {
    expect(T.persona.en).toMatch(/one question at a time/i);
    expect(T.persona.es).toMatch(/una sola pregunta a la vez/i);
    expect(T.persona.en).toMatch(/barbershop/i);
    expect(T.persona.es).toMatch(/barbería/i);
  });

  it('persona confirms with the tool readback and does not say refs are texted today', () => {
    expect(T.persona.en).toMatch(/confirm using the readback the tool returns/i);
    expect(T.persona.es).toMatch(/el resumen que devuelve la herramienta/i);
    expect(T.persona.en).toMatch(/will be texted once texting is enabled/i);
    expect(T.persona.es).toMatch(/se enviarán por mensaje de texto una vez que se activen/i);
    expect(T.persona.en).not.toMatch(/are sent by text|only the day, the time and the barber/i);
    expect(T.persona.es).not.toMatch(/se envían por mensaje|solo el día, la hora y el barbero/i);
  });

  it('has the expected shape', () => {
    expect(Object.keys(T).sort()).toEqual(
      ['afterWrite', 'asks', 'contracts', 'greeting', 'id', 'languages', 'persona', 'reads', 'version'],
    );
    expect(Object.keys(T.afterWrite).sort()).toEqual(['booked', 'cancelled', 'rescheduled', 'textWillFollow']);
    expect(Object.keys(T.asks).sort()).toEqual([...CONTRACT_ASK_IDS].sort());
    for (const phrase of [T.persona, T.greeting, ...Object.values(T.asks), ...Object.values(T.afterWrite)]) {
      expect(Object.keys(phrase).sort()).toEqual(['en', 'es']);
    }
  });
});

describe('barbershop@1 phrasing covers every contract askId', () => {
  it('found askIds in the contracts', () => {
    expect(CONTRACT_ASK_IDS.length).toBeGreaterThan(0);
  });

  for (const askId of CONTRACT_ASK_IDS) {
    for (const lang of TEMPLATE_LANGUAGES) {
      it(`${askId} has non-empty ${lang} phrasing`, () => {
        expect(phraseAsk(T, askId, lang)?.trim() ?? '').not.toBe('');
      });
    }
  }

  it('phrases no askId that no contract declares', () => {
    expect(Object.keys(T.asks).filter((id) => !CONTRACT_ASK_IDS.includes(id))).toEqual([]);
  });

  it('each ask is a single question', () => {
    for (const [askId, phrase] of Object.entries(T.asks)) {
      for (const lang of TEMPLATE_LANGUAGES) {
        expect((phrase[lang].match(/\?/g) ?? []).length, `${askId}.${lang}`).toBe(1);
      }
    }
  });

  it('booking.find asks for the first name before any booking is read back', () => {
    expect(T.asks['ask.bookingName'].en).toMatch(/first name/i);
    expect(T.asks['ask.bookingName'].es).toMatch(/primer nombre/i);
    expect(T.persona.en).toMatch(/get the first name it's under/i);
  });
});

describe('barbershop@1 text: no stage directions, no ref phrasing', () => {
  for (const [label, text] of allTexts()) {
    it(`${label} is clean`, () => {
      expect(stageDirectionIssues(text)).toEqual([]);
      expect(findRefs(text)).toEqual([]);
      expect(REF_PHRASING.filter((re) => re.test(text)).map(String)).toEqual([]);
    });
  }

  it('the lint used here catches a stage direction and ref phrasing', () => {
    expect(stageDirectionIssues('One moment (checking the book).')).not.toEqual([]);
    expect(stageDirectionIssues('Le reviso en voz baja.')).not.toEqual([]);
    expect(REF_PHRASING.some((re) => re.test('Your confirmation number is BK-4712.'))).toBe(true);
    expect(REF_PHRASING.some((re) => re.test('Su número de confirmación es 4712.'))).toBe(true);
    expect(findRefs('Your booking is BK-4712.')).not.toEqual([]);
  });
});

describe('barbershop@1 spoken lines pass the invariant SAY check (SMS off, refs not voiced)', () => {
  it('every ask passes before anything is committed', () => {
    for (const [askId, phrase] of Object.entries(T.asks)) {
      for (const lang of TEMPLATE_LANGUAGES) {
        expect(checkSay(facts(), phrase[lang]), `${askId}.${lang}`).toEqual({ ok: true });
      }
    }
  });

  const cases = [
    ['booked', 'scheduling.book.commit'],
    ['rescheduled', 'scheduling.reschedule.commit'],
    ['cancelled', 'scheduling.cancel.commit'],
  ] as const;

  for (const [key, action] of cases) {
    for (const lang of TEMPLATE_LANGUAGES) {
      it(`afterWrite.${key}.${lang} + the text line pass after an ok ${action}`, () => {
        const line = `${spokenAfterWrite(key, lang)} ${T.afterWrite.textWillFollow[lang]}`;
        expect(line).not.toMatch(/\{\{/);
        expect(checkSay(committed(action), line)).toEqual({ ok: true });
      });

      it(`afterWrite.${key}.${lang} is blocked before any commit`, () => {
        expect(checkSay(facts(), spokenAfterWrite(key, lang))).toMatchObject({ ok: false, rule: 'say.success_before_commit' });
      });
    }
  }

  it('afterWrite lines carry only the server readback, no date, time or barber formatting', () => {
    for (const [key] of cases) {
      for (const lang of TEMPLATE_LANGUAGES) {
        const placeholders = [...T.afterWrite[key][lang].matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
        expect(placeholders, `${key}.${lang}`).toEqual(['readback']);
      }
    }
    for (const phrase of [T.persona, ...Object.values(T.asks), T.afterWrite.textWillFollow]) {
      for (const lang of TEMPLATE_LANGUAGES) expect(phrase[lang]).not.toMatch(/\{\{/);
    }
  });
});

describe('barbershop@1 "a text will follow" line', () => {
  const promises = TEXT_PROMISE_PHRASES.map(normalizeSpeech);
  const qualifiers = SMS_OFF_QUALIFIERS.map(normalizeSpeech);
  const has = (text: string, list: readonly string[]) => list.some((p) => ` ${normalizeSpeech(text)} `.includes(` ${p} `));

  for (const lang of TEMPLATE_LANGUAGES) {
    it(`is present in ${lang} with the SMS-off qualifier`, () => {
      const line = T.afterWrite.textWillFollow[lang];
      expect(line.trim()).not.toBe('');
      expect(has(line, promises)).toBe(true);
      expect(has(line, qualifiers)).toBe(true);
      expect(checkSay(facts(), line)).toEqual({ ok: true });
    });
  }

  it('reads exactly as decided in English', () => {
    expect(T.afterWrite.textWillFollow.en).toBe('A text will follow once texting is enabled.');
  });

  it('the SAY check would block it without the qualifier', () => {
    expect(checkSay(facts(), 'A text will follow.')).toMatchObject({ ok: false, rule: 'say.text_promise_sms_off' });
  });
});
