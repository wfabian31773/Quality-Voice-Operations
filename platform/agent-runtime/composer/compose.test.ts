import { describe, expect, it } from 'vitest';
import { getAction, listActions } from '../../actions';
import { CONTRACTS, getContract } from '../../callcore/contracts';
import { TOOL_LIBRARY_NAMES } from '../../tools/library/catalog';
import type { AgentTemplate } from '../../agent-templates/shared';
import { afterWriteLine, compose, contractActionNames, RUNTIME_TOOL_NAMES } from './index';

/** A neutral fixture template: the composer must work for any template, not one vertical. */
const FIXTURE: AgentTemplate = {
  id: 'front-desk',
  version: 2,
  languages: ['en', 'es'],
  contracts: ['booking.book@1', 'tickets.message@1'],
  reads: ['scheduling.check_availability'],
  persona: { en: 'You answer the phone for a small business.', es: 'Usted contesta el teléfono de un negocio pequeño.' },
  greeting: { en: 'Thanks for calling {{businessName}}.', es: 'Gracias por llamar a {{businessName}}.' },
  asks: {
    'ask.service': { en: 'What can we do for you?', es: '¿Qué le hacemos?' },
    'ask.callbackNumber': { en: 'Best number for a call back?', es: '¿A qué número le llamamos?' },
  },
  afterWrite: {
    booked: { en: 'All set. {{readback}}', es: 'Listo. {{readback}}' },
    rescheduled: { en: 'Moved. {{readback}}', es: 'Cambiada. {{readback}}' },
    cancelled: { en: 'Cancelled. {{readback}}', es: 'Cancelada. {{readback}}' },
    textWillFollow: { en: 'A text will follow once texting is enabled.', es: 'Le llegará un mensaje una vez que se activen los mensajes de texto.' },
  },
};

const TENANT = { businessName: 'Corner Studio', businessDetails: 'Open Tue-Sat 9-7.' };

describe('compose: tools', () => {
  const composed = compose(FIXTURE, undefined, TENANT, { language: 'en' });
  const expectedActions = [...FIXTURE.contracts.flatMap((key) => contractActionNames(getContract(key)!)), ...FIXTURE.reads!];

  it('exposes exactly the selected contracts\' actions, the template\'s reads and the runtime tools', () => {
    expect(Object.values(composed.contractTools.actions)).toEqual(expectedActions);
    expect(composed.tools.map((t) => t.name)).toEqual([
      ...Object.keys(composed.contractTools.actions),
      ...RUNTIME_TOOL_NAMES,
    ]);
    expect(expectedActions).toEqual([
      'scheduling.book.prepare',
      'scheduling.book.commit',
      'tickets.open.prepare',
      'tickets.open.commit',
      'scheduling.check_availability',
    ]);
    expect(composed.contractTools.actions.scheduling_check_availability).toBe('scheduling.check_availability');
  });

  it('a template without reads gets only its contracts\' actions', () => {
    const none = compose({ ...FIXTURE, reads: undefined }, undefined, TENANT, {});
    expect(Object.values(none.contractTools.actions)).not.toContain('scheduling.check_availability');
  });

  it('refuses a template read that is a write, a prepare or not in the registry', () => {
    expect(() => compose({ ...FIXTURE, reads: ['scheduling.book.commit'] }, undefined, TENANT, {})).toThrow(/is a commit action, not a read/);
    expect(() => compose({ ...FIXTURE, reads: ['tickets.open.prepare'] }, undefined, TENANT, {})).toThrow(/not a read/);
    expect(() => compose({ ...FIXTURE, reads: ['scheduling.nope'] }, undefined, TENANT, {})).toThrow(/not in the action registry/);
    const write = listActions().find((def) => def.kind === 'write');
    if (write) expect(() => compose({ ...FIXTURE, reads: [write.name] }, undefined, TENANT, {})).toThrow(/is a write action, not a read/);
  });

  it('refuses a read action that is not agent-permitted', () => {
    const staffOnly = listActions().find((def) => def.kind === 'read' && def.permissions.agent !== true);
    expect(staffOnly, 'the registry has a read the agent may not run').toBeDefined();
    expect(() => compose({ ...FIXTURE, reads: [staffOnly!.name] }, undefined, TENANT, {})).toThrow(/not agent-permitted/);
  });

  it('every contract tool is a registered, agent-permitted action with its registry schema', () => {
    for (const [name, action] of Object.entries(composed.contractTools.actions)) {
      const def = getAction(action);
      expect(def?.permissions.agent, action).toBe(true);
      expect(composed.tools.find((t) => t.name === name)?.description).toBe(def?.agentDescription);
    }
  });

  it('exposes no tool-library tool', () => {
    const libraryOnly = TOOL_LIBRARY_NAMES.filter((n) => !(RUNTIME_TOOL_NAMES as readonly string[]).includes(n));
    expect(composed.tools.map((t) => t.name).filter((n) => libraryOnly.includes(n))).toEqual([]);
  });

  it('a narrower selection narrows the contract tools (the template\'s reads stay)', () => {
    const one = compose(FIXTURE, ['tickets.message@1'], TENANT, { language: 'en' });
    expect(Object.values(one.contractTools.actions)).toEqual(['tickets.open.prepare', 'tickets.open.commit', 'scheduling.check_availability']);
  });

  it('refuses a contract the template does not phrase, or one that does not exist', () => {
    expect(() => compose(FIXTURE, ['booking.cancel@1'], TENANT, {})).toThrow(/does not phrase/);
    expect(() => compose({ ...FIXTURE, contracts: ['booking.book@9'] }, undefined, TENANT, {})).toThrow(/Unknown contract/);
  });

  it('composes every exported contract (a read contract exposes its one action)', () => {
    const all = compose({ ...FIXTURE, contracts: CONTRACTS.map((c) => `${c.id}@${c.version}`) }, undefined, TENANT, {});
    expect(Object.values(all.contractTools.actions)).toContain('scheduling.find_bookings');
    expect(all.contractTools.callerIdPaths['scheduling.find_bookings']).toEqual(['phone']);
  });

  it('marks call-stable reads cacheable from the read data; availability and every write stay uncached', () => {
    expect(composed.contractTools.cacheable).toEqual({});
    const catalog = compose({ ...FIXTURE, reads: ['scheduling.list_services', 'scheduling.list_staff', 'scheduling.check_availability'] }, undefined, TENANT, {});
    expect(catalog.contractTools.cacheable).toEqual({ 'scheduling.list_services': 'call', 'scheduling.list_staff': 'call' });
    for (const action of Object.keys(catalog.contractTools.cacheable)) expect(getAction(action)?.kind).toBe('read');
  });

  it('a read contract\'s own cacheable flag flows to the binding (never for a write)', () => {
    const findKey = 'booking.find@1';
    const find = getContract(findKey)!;
    expect(find.cacheable).toBeUndefined();
    const all = compose({ ...FIXTURE, contracts: CONTRACTS.map((c) => `${c.id}@${c.version}`) }, undefined, TENANT, {});
    // Identity reads are not call-stable: none of the shipped contracts is cacheable.
    expect(Object.keys(all.contractTools.cacheable)).toEqual([]);
  });

  it('the tool list is pinned', () => {
    expect(composed.tools).toMatchSnapshot();
  });
});

describe('compose: prompt, greeting, keyterms', () => {
  it('puts persona, tool rules, business facts and caller ID in the call language', () => {
    const en = compose(FIXTURE, undefined, TENANT, { language: 'en-US', callerIdLine: 'Caller ends in 0142.' });
    expect(en.language).toBe('en');
    expect(en.prompt.startsWith(FIXTURE.persona.en)).toBe(true);
    expect(en.prompt).toContain('- Name: Corner Studio\nOpen Tue-Sat 9-7.');
    expect(en.prompt).toContain('Caller ID:\n- Caller ends in 0142.');
    expect(en.greeting).toBe('Thanks for calling Corner Studio.');
    expect(en.keyterms).toEqual(['Corner Studio']);

    const es = compose(FIXTURE, undefined, TENANT, { language: 'es' });
    expect(es.language).toBe('es');
    expect(es.prompt.startsWith(FIXTURE.persona.es)).toBe(true);
    expect(es.prompt).toContain('- Nombre: Corner Studio');
    expect(es.prompt).not.toContain('Caller ID');
    expect(es.greeting).toBe('Gracias por llamar a Corner Studio.');
  });

  it('strips stage directions from the business\'s own text', () => {
    const c = compose(FIXTURE, undefined, { businessName: 'X', businessDetails: 'Open late Fridays. (pause) Cash only.' }, {});
    expect(c.prompt).toContain('Open late Fridays. Cash only.');
    expect(c.prompt).not.toContain('(pause)');
  });

  it('a business with no name still composes, without a keyterm', () => {
    const c = compose(FIXTURE, undefined, { businessName: '  ' }, { language: 'es' });
    expect(c.greeting).toBe('Gracias por llamar a nuestro negocio.');
    expect(c.keyterms).toEqual([]);
  });
});

describe('compose: contract tool binding', () => {
  const { contractTools } = compose(FIXTURE, undefined, TENANT, {});

  it('carries the template asks for the selected contracts\' slots only', () => {
    expect(contractTools.asks).toEqual({
      'ask.service': FIXTURE.asks['ask.service'],
      'ask.callbackNumber': FIXTURE.asks['ask.callbackNumber'],
    });
  });

  it('maps each commit to its after-write line by contract intent (no line for a message)', () => {
    expect(contractTools.afterWrite).toEqual({ 'scheduling.book.commit': FIXTURE.afterWrite.booked });
  });

  it('lists the inputs held from caller ID', () => {
    expect(contractTools.callerIdPaths).toEqual({
      'scheduling.book.prepare': ['customer.phone'],
      'tickets.open.prepare': ['customer.phone'],
    });
  });
});

describe('afterWriteLine', () => {
  const { contractTools } = compose(FIXTURE, undefined, TENANT, {});

  it('fills the readback in the given language and adds the text line while SMS is off', () => {
    expect(afterWriteLine(contractTools, 'scheduling.book.commit', 'Confirmado: viernes.', 'es', false)).toBe(
      'Listo. Confirmado: viernes. Le llegará un mensaje una vez que se activen los mensajes de texto.',
    );
    expect(afterWriteLine(contractTools, 'scheduling.book.commit', 'Confirmed: Friday.', 'en', true)).toBe('All set. Confirmed: Friday.');
  });

  it('has nothing to say for a commit without a line, or without a readback', () => {
    expect(afterWriteLine(contractTools, 'tickets.open.commit', 'Sent.', 'en', false)).toBeUndefined();
    expect(afterWriteLine(contractTools, 'scheduling.book.commit', ' ', 'en', false)).toBeUndefined();
  });
});
