import { describe, expect, it } from 'vitest';
import { answeredInfoOnly, contentWords, hasCallbackNumber, normalizeTokens, saidMoreThanTheirOwnName } from './floorHeuristics';

describe('answeredInfoOnly', () => {
  const ANSWERED = { endReason: 'caller_hangup', tools: [], answered: true };
  const skips = (...lines: string[]) => answeredInfoOnly(lines, ANSWERED);

  it.each([
    ['What time do you close?'],
    ['Are you open on Saturday?'],
    ['Where are you located?'],
    ['How much is an oil change?'],
    ['Do you offer brake service?'],
    ["What's your phone number?"],
    ['Hi, this is Maria. What are your hours?'],
    ['¿A qué hora cierran?'],
    ['¿Dónde están ubicados?'],
    ['¿Cuánto cuesta un cambio de aceite?'],
    ['Soy Juan. ¿Cuál es su horario?'],
    ['Do you have a website?'],
    ['Do you have parking?'],
    ['Is brake service available?'],
    ['Is an oil change available?'],
    ['Hi this is Maria', 'what are your hours, please?', 'Thanks, bye'],
    ['What days does Marco work?'],
    ['Does Lisa work on the weekend?'],
    ['No, thanks. What time do you close?'],
    ['Yes. What are your hours?'],
    ['Hi, yes, what are your hours?'],
    ['What are your hours?', 'No.'],
    ['¿Están cerrados hoy?'],
    ['¿Cuándo abren?'],
    ['Cuándo abren.'],
    ['Do you do tire rotations?'],
    ['Is tire service available?'],
    ['¿Hacen alineaciones?'],
    ['¿Hacen cambio de aceite?'],
    ['¿Dónde queda el taller?'],
    ['¿Qué días trabaja Marco?'],
    ['¿Tienen estacionamiento?'],
    ['¿Tienen página web?'],
    ['Sí. ¿Abren el sábado?'],
    // The closed service list (EN/ES), with or without an article.
    ['Do you do oil changes?'],
    ['How much is a tune up?'],
    ['Do you do AC maintenance?'],
    ['Is AC maintenance available?'],
    ['How much is a manicure?'],
    ['Do you guys do pedicures?'],
    ['What do you charge for highlights?'],
    ['How much does a beard trim cost?'],
    ['Do you do detailing?'],
    ['What is the price of an alignment?'],
    ['¿Cuánto cuesta un corte de pelo?'],
    ['¿Hacen frenos?'],
    ['¿Ofrecen pedicura?'],
    ['¿Cuánto cobran por una afinación?'],
    ['¿Cuál es el precio de las llantas?'],
    // Location with "located" or a shop noun.
    ['Where is your shop located?'],
    ['Where is the shop?'],
    ['Where are you guys located at?'],
    ['¿Dónde está el taller?'],
    ['¿Dónde se encuentran ubicados?'],
    // Staff days, abbreviated too.
    ['Does Marco work Tues?'],
    ['Does Lisa work on Sat?'],
    // Intros with a capitalized name.
    ['Hola, me llamo Ana. ¿A qué hora cierran?'],
    ['Hola, soy Juan. ¿Cuál es su horario?'],
    // A closing "okay" right before thanks / bye is a sign-off, with or without commas.
    ['Hi this is Maria', 'what are your hours, please?', 'Okay, thanks, bye'],
    ['Hi this is Maria', 'what are your hours, please?', 'Okay thanks bye'],
    ['What are your hours?', 'Okay, thanks.'],
    ['¿A qué hora cierran?', 'Ok gracias adiós'],
    ['¿A qué hora cierran?', 'Ok, gracias, adiós.'],
  ])('skips an allowlisted info question ("%s")', (...lines) => {
    expect(skips(...lines)).toBe(true);
  });

  it.each([
    // The two Codex P1s: "open" as a request verb, and a problem clause that looked like "this is <name>".
    ['Can you open the garage door?'],
    ['This is broken. What time do you close?'],
    ['Can someone come out today?'],
    ['Can you send me a quote?'],
    ['My heater is not working, are you open?'],
    ['Can you check my order?'],
    ['What time do you close? I need to cancel'],
    ['¿Pueden abrir la puerta del garaje?'],
    ['Esto está roto. ¿A qué hora cierran?'],
    ['Quiero cancelar mi cita'],
    ['Soy Juan y mi calentador no funciona'],
  ])('files a request, problem or statement ("%s")', (...lines) => {
    expect(skips(...lines)).toBe(false);
  });

  it('files when a word is left over after a shape, or a slot holds a request, day or closed-class word', () => {
    expect(skips('What time do you close the gate?')).toBe(false);
    expect(skips('How much is the repair?')).toBe(false);
    expect(skips('How much is a fade today?')).toBe(false);
    expect(skips('Do you have anything open?')).toBe(false);
    expect(skips('Does anyone work Saturday?')).toBe(false);
  });

  it.each([
    'Do you have any times?',
    'Do you have spaces?',
    'Any room Saturday?',
    'Do you have any spots?',
    'Any openings tomorrow?',
    '¿Tienen lugar?',
    '¿Tienen lugares?',
    '¿Tienen espacios?',
    '¿Tienen cupo?',
    '¿Tienen cupos?',
    '¿Tienen huecos?',
    '¿Tienen turno?',
    '¿Tienen turnos?',
  ])('files an availability ask, plural or Spanish ("%s")', (line) => {
    expect(skips(line)).toBe(false);
  });

  it('a title\'s period does not split the introduction ("Dr. Patel")', () => {
    expect(skips('Hi, this is Dr. Patel. What are your hours?')).toBe(true);
  });

  it('pins today\'s verdict for a bare "Hours, please?": the comma leaves "Hours" unmarked, so it files', () => {
    expect(skips('Hours, please?')).toBe(false);
  });

  it('drops only a clause that is purely an introduction with a 1-2 word name', () => {
    expect(skips('This is Ana María', 'Are you open today?')).toBe(true);
    // A 3-word "name", or an intro carrying a problem word, stays a content clause and files.
    expect(skips('This is Luis Garcia Lopez', 'Are you open today?')).toBe(false);
    expect(skips('This is urgent', 'Are you open today?')).toBe(false);
    expect(skips('This is about my order', 'Are you open today?')).toBe(false);
  });

  it('takes "this is" / "habla" + name only when the name is capitalized or is the callerName', () => {
    expect(skips('this is maria', 'Are you open today?')).toBe(false);
    expect(answeredInfoOnly(['this is maria', 'Are you open today?'], { ...ANSWERED, callerName: 'Maria Lopez' })).toBe(true);
    expect(skips('Hola, habla Ana. ¿Abren hoy?')).toBe(true);
    expect(skips('hola, habla ana. ¿Abren hoy?')).toBe(false);
    // "my name is" / "mi nombre es" take a lowercase name only when the whole transcript is lowercase.
    expect(skips('my name is maria', 'are you open today?')).toBe(true);
    // With casing elsewhere, a lowercase "name" is not trusted ("My name is misspelled"), unless it is the callerName.
    expect(skips('my name is maria', 'Are you open today?')).toBe(false);
    expect(answeredInfoOnly(['My name is maria.', 'Are you open today?'], { ...ANSWERED, callerName: 'Maria' })).toBe(true);
    expect(skips('mi nombre es ana. ¿a qué hora cierran?')).toBe(true);
    expect(skips('mi nombre es ana. ¿A qué hora cierran?')).toBe(false);
    // "me llamo" / "soy" need a capitalized name or the callerName, like "this is".
    expect(skips('me llamo ana. ¿A qué hora cierran?')).toBe(false);
    expect(answeredInfoOnly(['me llamo ana. ¿A qué hora cierran?'], { ...ANSWERED, callerName: 'Ana' })).toBe(true);
    expect(skips('soy juan. ¿Cuál es su horario?')).toBe(false);
  });

  // Inputs the PR #153 review traced as skipping: each one is a request, a dispatch ask, a booking
  // time, a status question or a complaint, so each files.
  it.each([
    // P1: "is X available" with a person, role, vehicle or time.
    ['Is the manager available?'],
    ['Is Lisa available?'],
    ['Is a mechanic available?'],
    ['Is an electrician available?'],
    ['Is a locksmith available?'],
    ['Is a tow truck available?'],
    ['Is noon available?'],
    ['Is three thirty available?'],
    ['Is tow service available?'],
    // P1: "have" / "carry" / "tienen" with an open slot.
    ['Do you have a tow truck?'],
    ['Do you have a mechanic?'],
    ['Do you have a mechanic nearby?'],
    ['Do you have a guy?'],
    ['Do you carry a guy?'],
    ['¿Tienen grúa?'],
    ['¿Tienen electricista?'],
    ['Do you offer a mechanic?'],
    ['Do you do towing?'],
    ['¿Hacen grúa?'],
    // P2: a time word in the staff slot, or a lowercase "name".
    ['Does noon work?'],
    ['Does three work?'],
    ['Does later work?'],
    ['Does evening work?'],
    ['Does Noon work?'],
    ['does marco work saturdays?'],
    ['¿Qué días trabaja mediodía?'],
    // P2: plurals, turno, possessives, listo.
    ['Do you have any times?'],
    ['Do you have spaces?'],
    ['Do you offer times?'],
    ['¿Tienen huecos?'],
    ['¿Tienen cupos?'],
    ['¿Tienen espacios?'],
    ['¿Tienen lugares?'],
    ['¿Tienen turno?'],
    ['¿Ofrecen turnos?'],
    ['How much is mine?'],
    ['What does mine cost?'],
    ['How much are ours?'],
    ['¿Cuánto cuesta el mío?'],
    ['¿Cuánto cuesta el nuestro?'],
    ['¿Tienen el carro listo?'],
    // P2: a leading Spanish "no" negates the clause; "yes"/"no" is dropped only as the whole clause.
    ['No está abierto el taller.'],
    ['No abren hoy'],
    ['Yes what are your hours'],
    ['What are your hours?', 'Yes please.'],
    // P2: "this is <adjective>" is a complaint, not an introduction.
    ['This is horrible. Are you open?'],
    ['This is outrageous. Are you open?'],
    ['This is bad. Are you open?'],
    ['This is overdue. What are your hours?'],
    ['This is frustrating. What time do you close?'],
    ['This is Horrible. Are you open?'],
    // P3: the caller's own job or account.
    ['Do you have the part yet?'],
    ['¿Tienen el pedido?'],
    ['How much is the bill?'],
    ['How much is left?'],
    // A clock time is never an info question; the period or colon splits it into fragments.
    ['Does 3 p.m. work?'],
    ['Is 10:30 available?'],
    ['Do you have 10:30?'],
  ])('files what the review traced as skipping ("%s")', (...lines) => {
    expect(skips(...lines)).toBe(false);
  });

  // Inputs the second PR #153 review (at bc19a343) traced as skipping.
  it.each([
    // P1: problem words match by stem, so plurals and other forms file.
    ['Do you do emergencies?'],
    ['Do you guys do emergencies?'],
    ['¿Hacen emergencias?'],
    ['Do you do complaints?'],
    ['Do you do flood cleanup?'],
    ['¿Ofrecen inundaciones?'],
    ['Do you do leaks?'],
    ['Do you do damages?'],
    ['¿Hacen quejas?'],
    ['Do you do urgencies?'],
    ['How much are problems?'],
    // P2: come-out jobs in {S}, and "<word> service" in {SVC} is a closed list.
    ['Do you do lockouts?'],
    ['Do you do jump starts?'],
    ['Do you do flat tires?'],
    ['Do you do breakdowns?'],
    ['Do you do accidents?'],
    ['Do you do collisions?'],
    ['Do you do burst pipes?'],
    ['Do you do clogs?'],
    ['Do you do outages?'],
    ['¿Hacen choques?'],
    ['¿Hacen domicilios?'],
    ['Is mobile service available?'],
    ['Is lockout service available?'],
    ['Is emergency service available?'],
    // P2: a month or holiday in the staff slot offers a booking time.
    ['Does June work?'],
    ['Does August work?'],
    ['Does May work?'],
    ['Does Thanksgiving work?'],
    ['Does Christmas work?'],
    ['¿Qué días trabaja Diciembre?'],
    // P2: a Spanish yes/no without "¿?" reads the same as a statement.
    ['Están cerrados hoy.'],
    ['Están cerrados.'],
    ['Están abiertos'],
    ['Abren hoy.'],
    ['Está abierto el taller.'],
    // P3: the caller's own account, and replacement verbs like repair verbs.
    ['How much is due?'],
    ['How much is owed?'],
    ['How much is outstanding?'],
    ['How much is remaining?'],
    ['How much does Juan owe?'],
    ['¿Cuánto debo?'],
    ['How much does replacing brakes cost?'],
    ['¿Cuánto cuesta cambiar llantas?'],
    ['¿Cuánto cuesta reemplazar los frenos?'],
    // P3: asking for a person files, like "Is Lisa available?".
    ['Is Lisa in?'],
    ['Is Lisa working today?'],
    ['Is Marco in right now?'],
    // P3: a bare yes after the first clause may accept an offer.
    ['Do you offer brake service?', 'Yes.'],
    ['What are your hours?', 'Sí.'],
  ])('files what the second review traced as skipping ("%s")', (...lines) => {
    expect(skips(...lines)).toBe(false);
  });

  // Inputs the third PR #153 review (at 0fdc9c51) traced as skipping.
  it.each([
    // P2: come-out and dispatch jobs, close variants and Spanish synonyms; none is in the closed service list.
    ['Do you do lock outs?'],
    ['Do you do lock-outs?'],
    ['Do you do clogged drains?'],
    ['Do you do pipe bursts?'],
    ['Do you do dead batteries?'],
    ['Do you do home service?'],
    ['¿Ofrecen servicio móvil?'],
    ['¿Hacen remolques?'],
    ['¿Ofrecen servicio de remolque?'],
    ['¿Hacen cerrajería?'],
    ['¿Ofrecen asistencia vial?'],
    ['Do you do pickups?'],
    ['Do you do roadside assistance?'],
    ['Do you do house calls?'],
    // P2: "where are you" with no "located" or shop noun is what a caller waiting on a tech asks.
    ['Where are you?'],
    ['Where are you guys?'],
    ['Where are you at?'],
    ['¿Dónde están?'],
    ['¿Dónde está?'],
    ['¿Dónde queda?'],
    ['¿Dónde se encuentran?'],
    // P2: a later bare acceptance may accept a callback.
    ['What are your hours?', 'Please.'],
    ['What are your hours?', 'Por favor.'],
    ['What are your hours?', 'Okay.'],
    ['What are your hours?', 'Okay, please.'],
    ['What are your hours?', 'Thanks, yes.'],
    ['¿A qué hora cierran?', 'Sí, por favor.'],
    ['What are your hours?', 'Please, thanks.'],
    // P2: "me llamó X" is "X called me"; "soy" + a lowercase word is not a name.
    ['Hola, me llamó Marco. ¿A qué hora cierran?'],
    ['Hola, me llamó Marco', '¿A qué hora cierran?'],
    ['Soy repartidor. ¿A qué hora cierran?'],
    ['Hola, soy cliente. ¿Cuál es su horario?'],
    // P3: the caller's own account.
    ['How much is the total?'],
    ['How much is the deposit?'],
    ['How much is the deductible?'],
    ['How much is the copay?'],
    ['¿Cuánto sale la cuenta?'],
    ['¿Cuánto es el depósito?'],
    // P3: "does Marco work today" asks for him, like "Is Lisa working today?".
    ['Does Marco work today?'],
    ['Does Marco work tonight?'],
    ['Does Marco work tomorrow?'],
    ['Does Marco work right now?'],
    // P3: "no" is not a service.
    ['Do you do no heat?'],
    // P3: an abbreviated day in the staff slot offers a booking time.
    ['Does Tues work?'],
    ['Does Sat work?'],
    ['Does Mon work?'],
    ['Does Thurs work?'],
    ['Does Fri work?'],
  ])('files what the third review traced as skipping ("%s")', (...lines) => {
    expect(skips(...lines)).toBe(false);
  });

  // ASR often drops commas and periods: a no-comma line is one clause, so an intro or a lead-in can't be split
  // from the question and the call files; separate lines still split.
  it.each<[string[], boolean]>([
    [['Hi this is Maria what are your hours'], false],
    [['No thanks what time do you close'], false],
    [['Yes what are your hours'], false],
    [['Hi yes what are your hours'], false],
    [['Si abren el sabado'], false],
    [['Soy Juan cual es su horario'], false],
    [['This is broken what time do you close'], false],
    [['This is horrible are you open'], false],
    [['Hola me llamó Marco a qué hora cierran'], false],
    [['What are your hours', 'Please'], false],
    [['What are your hours', 'Yes please'], false],
    [['What are your hours', 'Okay'], false],
    [['Do you offer brake service', 'Yes'], false],
    [['What time do you close I need to cancel'], false],
    [['Where are you located'], true],
    [['What are your hours please'], true],
    [['Hi this is Maria', 'what are your hours please', 'Thanks bye'], true],
    [['Hi this is Maria', 'what are your hours please', 'Okay thanks bye'], true],
    [['What are your hours', 'No'], true],
  ])('no-comma ASR variant %j → skips %s', (lines, expected) => {
    expect(skips(...lines)).toBe(expected);
  });

  it.each<[string[], boolean]>([
    // Fourth review: a bare contact / price noun is often an answer to the agent, so it needs "?" / "¿".
    [['Do you do oil changes?', 'Email.'], false],
    [['¿Hacen frenos?', 'Teléfono.'], false],
    [['Do you do oil changes?', 'Phone number.'], false],
    [['¿Hacen frenos?', 'Correo electrónico.'], false],
    [['Price.'], false],
    [['Email?'], true],
    [["What's your email?"], true],
    [['¿Teléfono?'], true],
    // "the" + service reads as the caller's own job.
    [['How much is the brake job?'], false],
    [['How much are the tires?'], false],
    [['Is the tire available?'], false],
    [['How much is an oil change?'], true],
    // More time words never count as a staff name.
    [['DOES MIDDAY WORK?'], false],
    [['Does Lunch work?'], false],
    [['Does Weds work?'], false],
    [['¿Qué? Están cerrados hoy.'], false],
    // Fifth review: a naming intro with a non-name word is not an introduction.
    [['Where are you located?', 'My name is misspelled.'], false],
    [['What are your hours?', 'My name is incorrect.'], false],
    [['What are your hours?', 'My name is different.'], false],
    [['¿A qué hora cierran?', 'Mi nombre es incorrecto.'], false],
    [['What are your hours?', 'My name is spelled differently.'], false],
    [['My name is Ana.', 'Are you open today?'], true],
    // Sixth review: casing evidence comes from the whole transcript, so a lead-in or comma can't hide it.
    [['What are your hours?', 'And my name is spelled differently.'], false],
    [['What are your hours?', 'Oh, my name is spelled differently.'], false],
    [['What are your hours, my name is spelled differently.'], false],
    [['¿A qué hora cierran?', 'Y mi nombre es otro.'], false],
    [['what are your hours', 'my name is changed'], false],
    [['Hi, my name is Ana.', 'Are you open today?'], true],
    [['and my name is maria', 'what are your hours?'], true],
    // A bare hours noun needs "?" / "¿".
    [['Do you do brake service?', 'Hours.'], false],
    [['¿Hacen frenos?', 'Horario.'], false],
    [['Hours?'], true],
    [['¿Horario?'], true],
    // All-caps text is no casing evidence; month abbreviations are times.
    [['THIS IS PAST DUE.', 'WHAT ARE YOUR HOURS?'], false],
    [['DOES SEPT WORK?'], false],
    [['Does Jan work?'], false],
    // HVAC: only planned maintenance skips.
    [['Do you do furnace service?'], false],
    [['Do you do heating service?'], false],
    [['¿Hacen servicio del aire?'], false],
    [['Do you do furnace maintenance?'], true],
  ])('fourth review: %j -> %s', (lines, expected) => {
    expect(answeredInfoOnly(lines, ANSWERED)).toBe(expected);
  });

  it('files greetings and introductions with no question at all', () => {
    expect(skips('Hi, this is Maria')).toBe(false);
    expect(skips('Hello?', 'Thanks, bye')).toBe(false);
  });
});

describe('hasCallbackNumber', () => {
  it.each(['5552013344', '+15552013344', '555 201 3344', '(555) 201-3344', '555.201.3344', 'call 555 2013 please'])(
    'finds a callback number in "%s"',
    (line) => expect(hasCallbackNumber([line])).toBe(true),
  );

  it.each(['at 3 or 4', 'Saturday 10 to 12', 'a fade is $25, 30 with beard'])('finds no number in "%s"', (line) =>
    expect(hasCallbackNumber([line])).toBe(false),
  );
});

describe('normalizeTokens', () => {
  it('lowercases, folds diacritics and strips punctuation', () => {
    expect(normalizeTokens('¡Sí! Adiós, José… it’s OK?')).toEqual(['si', 'adios', 'jose', 'its', 'ok']);
  });

  it('drops the U+2018 and U+02BC apostrophes too, so "it‘s" and "Iʼm" stay one token', () => {
    expect(normalizeTokens('it‘s')).toEqual(['its']);
    expect(normalizeTokens('Iʼm Luis')).toEqual(['im', 'luis']);
  });
});

describe('saidMoreThanTheirOwnName', () => {
  it('is false for nothing at all', () => {
    expect(saidMoreThanTheirOwnName([])).toBe(false);
    expect(saidMoreThanTheirOwnName(['', '  ...  '])).toBe(false);
  });

  it('is false for a greeting and a name, with or without the name supplied', () => {
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis.'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis.'], 'Luis')).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hola, soy Ana'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hola', 'me llamo Ana María'], 'Ana María')).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hello?', 'My name is Luis Garcia', 'yes', 'thank you, bye'], 'Luis Garcia')).toBe(false);
    expect(saidMoreThanTheirOwnName(["it's José"], 'Jose')).toBe(false);
  });

  it('is false for filler only', () => {
    expect(saidMoreThanTheirOwnName(['uh', 'um, hmm', 'okay, yeah', 'sí, bueno, gracias', 'adiós'])).toBe(false);
  });

  it('is true once two content words remain across all lines', () => {
    expect(saidMoreThanTheirOwnName(['I need a fade Friday'])).toBe(true);
    expect(saidMoreThanTheirOwnName(['quiero una cita el viernes'])).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis', 'haircut', 'tomorrow'], 'Luis')).toBe(true);
  });

  it('needs two words, not one', () => {
    expect(contentWords(['Hi this is Luis', 'haircut'], 'Luis')).toEqual(['haircut']);
    expect(saidMoreThanTheirOwnName(['Hi this is Luis', 'haircut'], 'Luis')).toBe(false);
  });

  it('removes name tokens wherever they appear, accent-insensitively', () => {
    expect(contentWords(['José speaking, José Pérez, call me'], 'Jose Perez')).toEqual(['call', 'me']);
  });

  it('is false for common self-introductions and greetings without a supplied name', () => {
    expect(saidMoreThanTheirOwnName(["Hi, I'm Luis"])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hi, I‘m Luis'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['I am Luis'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['mi nombre es Ana'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Luis here'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Luis speaking'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['habla Ana'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['buenos días'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Good morning', 'good afternoon'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Buenas tardes', 'buenas noches'])).toBe(false);
  });

  it('is true for a self-introduction followed by a request ("Hi, I\'m Luis, I need a fade")', () => {
    expect(contentWords(["Hi, I'm Luis, I need a fade"])).toEqual(['luis', 'i', 'need', 'a', 'fade']);
    expect(saidMoreThanTheirOwnName(["Hi, I'm Luis, I need a fade"])).toBe(true);
    expect(saidMoreThanTheirOwnName(["Hi, I'm Luis, I need a fade"], 'Luis')).toBe(true);
  });

  it('removes filler phrases only as whole runs', () => {
    // "this" and "is" alone are content; only the "this is" run is filler.
    expect(contentWords(['is this open'])).toEqual(['is', 'this', 'open']);
    expect(contentWords(['this is for Friday'])).toEqual(['for', 'friday']);
  });

  it('counts a contiguous callback number (7+ digits in one token) as substantive on its own', () => {
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis, 5552013344'], 'Luis')).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis +15552013344'], 'Luis')).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis (555)201-3344'], 'Luis')).toBe(true);
    expect(saidMoreThanTheirOwnName(['Luis 42'], 'Luis')).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis, 555201'], 'Luis')).toBe(false);
  });

  it('drops a multi-word name after an intro phrase when it ends the line (no callerName)', () => {
    expect(contentWords(['Hi, this is Luis Garcia'])).toEqual([]);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['My name is Luis Garcia Lopez'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hello, this is Luis Garcia'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['this is Luis Garcia'])).toBe(false);
    expect(contentWords(['Hola, habla María José López'])).toEqual([]);
    expect(saidMoreThanTheirOwnName(['Hola, habla María José López'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Buenas tardes, le habla Ana Ruiz'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hola, soy Ana Ruiz'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['me llamo Ana María Ruiz'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['mi nombre es Ana Ruiz'])).toBe(false);
  });

  it('keeps everything after the name, and never swallows a request as a name', () => {
    expect(contentWords(['Hi, this is Luis Garcia, I need a fade Friday'])).toEqual(['luis', 'garcia', 'i', 'need', 'a', 'fade', 'friday']);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia, I need a fade Friday'])).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hola, habla María José López, quiero una cita'])).toBe(true);
    expect(contentWords(['this is about my booking Friday'])).toEqual(['about', 'my', 'booking', 'friday']);
    expect(saidMoreThanTheirOwnName(['this is about my booking Friday'])).toBe(true);
    // More than 3 tokens, or a common word in the tail, is not a name.
    expect(saidMoreThanTheirOwnName(['this is my booking'])).toBe(true);
    expect(saidMoreThanTheirOwnName(['soy de la tienda'])).toBe(true);
    // The name only counts when it ends the line; a later line still counts.
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia', 'haircut tomorrow'])).toBe(true);
  });

  it.each([undefined, 'Luis'])('does not read "I\'m ..." as an introduction (callerName %s)', (callerName) => {
    expect(saidMoreThanTheirOwnName(["I'm canceling tomorrow"], callerName)).toBe(true);
    expect(saidMoreThanTheirOwnName(["I'm running late today"], callerName)).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia'], callerName)).toBe(false);
  });

  describe('never swallows a request as a name', () => {
    it('still drops a name that ends the last clause', () => {
      expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia'])).toBe(false);
      expect(saidMoreThanTheirOwnName(['Hola, habla María José López'])).toBe(false);
      expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia.'])).toBe(false);
      expect(saidMoreThanTheirOwnName(['Hi, this is Luis'])).toBe(false);
      expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia-Lopez'])).toBe(false);
    });

    describe('still drops a name that ends the last clause', () => {
      it.each([
        'Hi, this is Luis Garcia, thanks',
        'Hola, habla Ana Ruiz, gracias',
        'Hi, this is Luis Garcia. Bye.',
        'Hi, this is Luis Garcia."',
        'Hi, this is Dr. Patel',
        'This is Luis A. Garcia',
      ])('"%s" is not substantive with no callerName', (line) => {
        expect(saidMoreThanTheirOwnName([line])).toBe(false);
      });

      it.each([
        // A closing "thanks" is skipped, so the request clause is the last one.
        'Hi, this is Ana, running late, thanks',
        // "Ana." is not an abbreviation, so the period still breaks the clause.
        'This is Ana. Cancel Friday',
      ])('"%s" is substantive with callerName "Ana"', (line) => {
        expect(saidMoreThanTheirOwnName([line], 'Ana')).toBe(true);
      });
    });

    it.each([
      ['This is Luis, cancel Friday', 'Luis'],
      ['Hi, this is Ana, running late', 'Ana'],
      ['Soy Ana, quiero cita', 'Ana'],
      ['This is Luis — cancel Friday', 'Luis'],
      ['Soy Ana… quiero cita', 'Ana'],
      ['Hi, this is Ana - running late', 'Ana'],
    ])('"%s" is substantive, with no callerName and with callerName %s', (line, callerName) => {
      expect(saidMoreThanTheirOwnName([line])).toBe(true);
      expect(saidMoreThanTheirOwnName([line], callerName)).toBe(true);
    });

    it.each([
      // With callerName "Ana" only "cancelo" is left (one word), as at 412e33c3.
      'Buenas tardes, habla Ana, cancelo',
      'soy cliente nuevo, quiero una cita',
    ])('"%s" is substantive with no callerName', (line) => {
      expect(saidMoreThanTheirOwnName([line])).toBe(true);
    });

    it('keeps the request after the name in the content words', () => {
      expect(contentWords(['This is Luis, cancel Friday'], 'Luis')).toEqual(['cancel', 'friday']);
      expect(contentWords(['Soy Ana, quiero cita'], 'Ana')).toEqual(['quiero', 'cita']);
    });
  });
});
