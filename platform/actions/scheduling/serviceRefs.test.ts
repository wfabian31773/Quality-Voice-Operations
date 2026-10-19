// Service refs: the agent may send a service's exact name or alias where a
// service id goes (live call 2026-10-18: list_staff({serviceId:"fade"}) failed,
// costing a list_services round trip). One resolver (serviceMatch.ts
// resolveServiceRef, serviceRefs.ts) serves list_staff, check_availability and
// book.prepare's slot scope.
import { describe, expect, it, vi } from 'vitest';
import { serviceAliases, type ServiceKey } from '../../../shared/scheduling/serviceLexicon';
import { createMemoryStore, runAction, type ActionContext, type ActionResult, type TenantTx } from '../index';
import { isActionFailure } from '../core';
import { resolveServiceRef } from './serviceMatch';
import { slotScope } from './slots';

const TENANT = 'tenant-sharp-line';
const OTHER = 'tenant-other-shop';
const MON_0800 = new Date('2026-10-19T12:00:00Z'); // Mon Oct 19 2026, 8:00 AM EDT

type Rows = Record<string, unknown>[];

/** Same names and aliases as scripts/seed-demo-barbershop.ts. */
function seededService(id: string, key: ServiceKey | null, name: string, aliases?: string[]) {
  return {
    id,
    name,
    duration_minutes: 30,
    buffer_minutes: 0,
    price_kind: 'fixed',
    price_cents: 3000,
    price_max_cents: null,
    aliases: aliases ?? (key ? serviceAliases(key).filter((a) => a.toLowerCase() !== name.toLowerCase()) : []),
  };
}

function shop(services: Rows, providers: string[]): Record<string, Rows> {
  return {
    scheduling_appointment_types: services,
    scheduling_providers: providers.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
    scheduling_provider_services: [
      ...services.map((s) => ({ provider_id: providers[0], appointment_type_id: s.id })),
      ...(providers[1] ? [{ provider_id: providers[1], appointment_type_id: services[1].id }] : []),
    ],
    scheduling_business_hours: [1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, open_time: '09:00:00', close_time: '17:00:00' })),
    scheduling_provider_schedules: [],
    scheduling_overrides: [],
    scheduling_booking_rules: [],
    bookings: [],
  };
}

const SHARP_LINE: Rows = [
  seededService('beard', 'beard_trim', 'Beard trim'),
  seededService('fade', 'fade', 'Fade'),
  seededService('cut', 'haircut', 'Haircut'),
  seededService('combo', 'cut_and_beard', 'Haircut and beard'),
  seededService('shave', 'hot_towel_shave', 'Hot towel shave'),
  seededService('kids', 'kids_cut', 'Kids cut'),
  seededService('lineup', 'lineup', 'Lineup'),
  seededService('taper', 'taper', 'Taper'),
];

/** Rows per tenant: a query only ever sees the rows of the tenant it was scoped to ($1). */
function tenants(own: Rows = SHARP_LINE): Record<string, Record<string, Rows>> {
  return {
    [TENANT]: shop(own, ['marcus', 'dee']),
    [OTHER]: shop([seededService('perm', null, 'Perm', ['permanente']), seededService('other-fade', null, 'Skin fade')], ['zoe']),
  };
}

function txFor(data = tenants()) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const tables = data[String(values?.[0])] ?? {};
    const table = Object.keys(tables).find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    const rows = table ? tables[table] : [];
    return { rows, rowCount: rows.length };
  });
  return { tx: { query } as TenantTx, query };
}

function ctx(extra: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: TENANT,
    actor: { type: 'agent', id: 'agent-1' },
    now: MON_0800,
    tenantTimezone: 'America/New_York',
    callId: 'CA-service-refs',
    ...extra,
  };
}

async function run(name: string, input: unknown, data = tenants(), extra: Partial<ActionContext> = {}) {
  const { tx, query } = txFor(data);
  const runtime = { store: createMemoryStore(), withTenantTx: async <T>(_t: string, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const result = await runAction(name, ctx(extra), input, runtime);
  return { result, query };
}

function errorOf(result: ActionResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

function staffIds(result: ActionResult): string[] {
  expect(result.ok).toBe(true);
  return result.ok ? (result.data as { id: string }[]).map((s) => s.id) : [];
}

describe('resolveServiceRef (pure)', () => {
  const catalog = {
    services: SHARP_LINE.map((r) => ({ id: String(r.id), name: String(r.name), aliases: r.aliases as string[] })),
  };

  it('takes an exact id first, then an exact name or alias, ignoring case, accents and articles', () => {
    expect(resolveServiceRef(catalog, 'fade')).toMatchObject({ status: 'found', matchedBy: 'id' });
    expect(resolveServiceRef(catalog, 'FADE')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'fade' } });
    expect(resolveServiceRef(catalog, 'a skin fade')).toMatchObject({ status: 'found', matchedBy: 'alias', service: { id: 'fade' } });
    expect(resolveServiceRef({ services: [{ id: 'x', name: 'Corte clásico' }] }, 'corte CLASICO'))
      .toMatchObject({ status: 'found', matchedBy: 'name' });
    expect(resolveServiceRef(catalog, 'DESVANECIDO')).toMatchObject({ status: 'found', matchedBy: 'alias', service: { id: 'fade' } });
  });

  it('drops a leading article in English or Spanish ("the fade", "el degradado")', () => {
    expect(resolveServiceRef(catalog, 'the fade')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'fade' } });
    expect(resolveServiceRef(catalog, 'el degradado')).toMatchObject({ status: 'found', matchedBy: 'alias', service: { id: 'fade' } });  });

  it('never picks "Combo A" for "combo": an article inside or at the end of a name is part of it', () => {
    const combos = { services: [{ id: 'ca', name: 'Combo A' }, { id: 'cb', name: 'Combo B' }] };
    const combo = resolveServiceRef(combos, 'combo');
    expect(combo.status).not.toBe('found');
    if (combo.status === 'unknown') expect(combo.suggestions.map((s) => s.id).sort()).toEqual(['ca', 'cb']);
    if (combo.status === 'ambiguous') expect(combo.candidates.map((s) => s.id).sort()).toEqual(['ca', 'cb']);
    expect(resolveServiceRef(combos, 'Combo A')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'ca' } });
    expect(resolveServiceRef(combos, 'combo b')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'cb' } });
    expect(resolveServiceRef(combos, 'the combo a')).toMatchObject({ status: 'found', service: { id: 'ca' } });
  });

  it('a single-letter suffix service alone on the menu is not matched by its stem', () => {
    const alone = { services: [{ id: 'pa', name: 'Package A' }, { id: 'pk', name: 'Mani', aliases: ['package deal una'] }] };
    expect(resolveServiceRef(alone, 'package').status).toBe('unknown');
    expect(resolveServiceRef(alone, 'package deal').status).toBe('unknown');
    expect(resolveServiceRef(alone, 'Package A')).toMatchObject({ status: 'found', service: { id: 'pa' } });
    // Its stem only resolves when the stem is itself an exact name or alias.
    const aliased = { services: [{ id: 'pa', name: 'Package A', aliases: ['package'] }] };
    expect(resolveServiceRef(aliased, 'package')).toMatchObject({ status: 'found', matchedBy: 'alias', service: { id: 'pa' } });
  });

  it('matches a singular ref to a plural menu name or alias, and a plural ref to a singular one', () => {
    const menu = {
      services: [
        { id: 's1', name: 'Massages' },
        { id: 'color', name: 'Color', aliases: ['Highlights'] },
        { id: 'brush', name: 'Brush out' },
        { id: 'fade', name: 'Fade', aliases: ['Degradados'] },
        { id: 'beard', name: 'Barba' },
      ],
    };
    expect(resolveServiceRef(menu, 'massage')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 's1' } });
    expect(resolveServiceRef(menu, 'a massage')).toMatchObject({ status: 'found', service: { id: 's1' } });
    expect(resolveServiceRef(menu, 'highlight')).toMatchObject({ status: 'found', matchedBy: 'alias', service: { id: 'color' } });
    expect(resolveServiceRef(menu, 'colors')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'color' } });
    expect(resolveServiceRef(menu, 'brushes out')).toMatchObject({ status: 'found', service: { id: 'brush' } });
    expect(resolveServiceRef(menu, 'degradado')).toMatchObject({ status: 'found', matchedBy: 'alias', service: { id: 'fade' } });
    expect(resolveServiceRef(menu, 'barbas')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'beard' } });
    // Spanish the other way: a plural ref against a singular alias.
    const singularAlias = { services: [{ id: 'fade', name: 'Fade', aliases: ['degradado'] }, { id: 'cut', name: 'Corte' }] };
    expect(resolveServiceRef(singularAlias, 'Degradados')).toMatchObject({ status: 'found', matchedBy: 'alias', service: { id: 'fade' } });
    expect(resolveServiceRef(singularAlias, 'cortes')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'cut' } });
  });

  it('a singular and its plural both on the menu stay ambiguous, never a pick', () => {
    const both = { services: [{ id: 'one', name: 'Massage' }, { id: 'many', name: 'Massages' }] };
    for (const ref of ['massage', 'Massages']) {
      const found = resolveServiceRef(both, ref);
      expect(found.status).toBe('ambiguous');
      if (found.status === 'ambiguous') expect(found.candidates.map((s) => s.id).sort()).toEqual(['many', 'one']);
    }
  });

  it('a word ending in "s" that is not a plural never folds onto a shorter menu item', () => {
    const menu = { services: [{ id: 's1', name: 'Bass' }, { id: 's2', name: 'Bas' }, { id: 'gloss', name: 'Hair gloss' }] };
    expect(resolveServiceRef(menu, 'bass')).toMatchObject({ status: 'found', service: { id: 's1' } });
    expect(resolveServiceRef(menu, 'bas')).toMatchObject({ status: 'found', service: { id: 's2' } });
    expect(resolveServiceRef(menu, 'hair glos').status).toBe('unknown');
    expect(resolveServiceRef(menu, 'hair glosses')).toMatchObject({ status: 'found', service: { id: 'gloss' } });
    // "Kids cut" keeps its "s"; "kid cut" is its singular and still finds it.
    expect(resolveServiceRef(catalog, 'kids cut')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'kids' } });
    expect(resolveServiceRef(catalog, 'kid cut')).toMatchObject({ status: 'found', service: { id: 'kids' } });
  });

  it('never resolves through the looser matcher: a phrase inside a sentence only ranks the suggestions', () => {
    const found = resolveServiceRef(catalog, 'can I get a fade on Saturday');
    expect(found.status).toBe('unknown');
    if (found.status === 'unknown') expect(found.suggestions[0].id).toBe('fade');
  });

  it('matches English "-y" / "-ies" plurals both ways', () => {
    const menu = { services: [{ id: 'facial', name: 'Facial Therapies' }, { id: 'lash', name: 'Eyelash Specialty' }, { id: 'series', name: 'Lash Series' }] };
    expect(resolveServiceRef(menu, 'facial therapy')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'facial' } });
    expect(resolveServiceRef(menu, 'Facial Therapies')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'facial' } });
    expect(resolveServiceRef(menu, 'eyelash specialties')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'lash' } });
    expect(resolveServiceRef(menu, 'the lash series')).toMatchObject({ status: 'found', matchedBy: 'name', service: { id: 'series' } });
    const both = { services: [{ id: 'one', name: 'Facial Therapy' }, { id: 'many', name: 'Facial Therapies' }] };
    for (const ref of ['facial therapy', 'facial therapies']) expect(resolveServiceRef(both, ref).status).toBe('ambiguous');
  });
});

/** A nail salon menu: "uña(s)" folds to "una(s)", which is also a Spanish article. */
const NAILS: Rows = [
  seededService('gel', 'gel_manicure', 'Uñas de Gel', ['uña de gel', 'gel nails']),
  seededService('acrylic', null, 'Uñas Acrílicas', []),
  seededService('mani', 'manicure', 'Manicura', []),
  seededService('pedi', 'pedicure', 'Pedicura', []),
];

const NAIL_REFS: [string, string][] = [
  ['uña de gel', 'gel'],
  ['uñas de gel', 'gel'],
  ['Uña de Gel', 'gel'],
  ['unas de gel', 'gel'], // caller/ASR without the ñ
  ['una de gel', 'gel'],
  ['unas uñas de gel', 'gel'], // article + service
  ['una manicura', 'mani'],
  ['la pedicura', 'pedi'],
  ['las uñas acrílicas', 'acrylic'],
  ['uñas acrilicas', 'acrylic'],
  ['uña acrílica', 'acrylic'],
  ['unas acrilicas', 'acrylic'],
];

describe('Spanish nail-salon names: "uña" is never the article "una"', () => {
  const catalog = {
    services: NAILS.map((r) => ({ id: String(r.id), name: String(r.name), aliases: r.aliases as string[] })),
  };

  it('resolves every nail ref to its service (pure)', () => {
    for (const [ref, id] of NAIL_REFS) {
      expect({ ref, found: resolveServiceRef(catalog, ref) }).toMatchObject({ ref, found: { status: 'found', service: { id } } });
    }
  });

  it('resolves a catalog name typed without the ñ ("Unas Acrilicas") the same way', () => {
    const typed = { services: [{ id: 'acrylic', name: 'Unas Acrilicas' }, { id: 'gel', name: 'Uñas de Gel' }] };
    for (const ref of ['uñas acrílicas', 'unas acrilicas', 'las uñas acrílicas']) {
      expect(resolveServiceRef(typed, ref)).toMatchObject({ status: 'found', service: { id: 'acrylic' } });
    }
  });

  it('nothing looser than an exact name or alias: "de gel" and "uñas" alone are unknown', () => {
    for (const ref of ['de gel', 'uñas', 'gel acrílico']) expect(resolveServiceRef(catalog, ref).status).toBe('unknown');
  });

  it('unaccented "unas"/"una" read both ways never guesses between two services', () => {
    const menu = { services: [{ id: 'acr', name: 'Acrílicas' }, { id: 'nails', name: 'Uñas Acrílicas' }] };
    // "unas acrilicas" is "some acrylics" or "acrylic nails": both are on this menu, so the agent asks.
    const found = resolveServiceRef(menu, 'unas acrilicas');
    expect(found.status).toBe('ambiguous');
    if (found.status === 'ambiguous') expect(found.candidates.map((s) => s.id).sort()).toEqual(['acr', 'nails']);
    // The ñ settles it; so does a second article.
    expect(resolveServiceRef(menu, 'uñas acrílicas')).toMatchObject({ status: 'found', service: { id: 'nails' } });
    expect(resolveServiceRef(menu, 'las uñas acrílicas')).toMatchObject({ status: 'found', service: { id: 'nails' } });
    expect(resolveServiceRef(menu, 'las acrílicas')).toMatchObject({ status: 'found', service: { id: 'acr' } });
  });

  it('list_staff resolves every nail ref', async () => {
    for (const [ref, id] of NAIL_REFS) {
      const { result } = await run('scheduling.list_staff', { serviceId: ref }, tenants(NAILS), { locale: 'es-US' });
      expect({ ref, ok: result.ok }).toEqual({ ref, ok: true });
      const expected = id === 'acrylic' ? ['marcus', 'dee'] : ['marcus'];
      expect({ ref, staff: staffIds(result) }).toEqual({ ref, staff: expected });
    }
  });

  it('check_availability gives the same slots for the name, the ñ-less ref and the id', async () => {
    const input = { staffId: 'any', date: '2026-10-20' };
    const byId = (await run('scheduling.check_availability', { ...input, serviceIds: ['gel'] }, tenants(NAILS))).result;
    expect(byId.ok).toBe(true);
    for (const ref of ['uña de gel', 'unas de gel', 'Uñas de Gel']) {
      expect((await run('scheduling.check_availability', { ...input, serviceIds: [ref] }, tenants(NAILS))).result).toEqual(byId);
    }
  });

  it('book.prepare slot scope stores the right service id for every nail ref', async () => {
    for (const [ref, id] of NAIL_REFS) {
      const found = await slotScope(txFor(tenants(NAILS)).tx, ctx(), { serviceIds: [ref], staffId: 'any' });
      expect({ ref, failed: isActionFailure(found) }).toEqual({ ref, failed: false });
      if (!isActionFailure(found)) expect({ ref, ids: found.services.map((s) => s.id) }).toEqual({ ref, ids: [id] });
    }
  });
});

describe('scheduling.list_staff with a service name', () => {
  it('resolves an exact name the way the live call sent it ({serviceId:"fade"} → Fade)', async () => {
    // "fade" is also this test catalog's id; the name path is proven with other casing below.
    expect(staffIds((await run('scheduling.list_staff', { serviceId: 'fade' })).result)).toEqual(['marcus', 'dee']);
    expect(staffIds((await run('scheduling.list_staff', { serviceId: 'Fade' })).result)).toEqual(['marcus', 'dee']);
  });

  it('resolves a name when ids are opaque (production uuids behind handles)', async () => {
    const uuid = '8f0c6a2e-4b1d-4c3e-9a7f-2d5e6b8c9a01';
    const own = SHARP_LINE.map((r) => (r.id === 'fade' ? { ...r, id: uuid } : r));
    const { result } = await run('scheduling.list_staff', { serviceId: 'fade' }, tenants(own));
    expect(result.ok && (result.data as { id: string; serviceIds: string[] }[]).every((m) => m.serviceIds.includes(uuid))).toBe(true);
    expect(staffIds(result)).toEqual(['marcus', 'dee']);
  });

  it('resolves a Spanish alias (migration 125 aliases)', async () => {
    const uuid = '8f0c6a2e-4b1d-4c3e-9a7f-2d5e6b8c9a02';
    const own = SHARP_LINE.map((r) => (r.id === 'fade' ? { ...r, id: uuid } : r));
    expect(staffIds((await run('scheduling.list_staff', { serviceId: 'degradado' }, tenants(own))).result)).toEqual(['marcus', 'dee']);
    expect(staffIds((await run('scheduling.list_staff', { serviceId: 'Degradado' }, tenants(own))).result)).toEqual(['marcus', 'dee']);
  });

  it('resolves a singular name against a plural menu name ("massage" → Massages)', async () => {
    const own = [...SHARP_LINE.slice(0, 1), seededService('svc-massage', null, 'Massages', []), ...SHARP_LINE.slice(2)];
    expect(staffIds((await run('scheduling.list_staff', { serviceId: 'massage' }, tenants(own))).result)).toEqual(['marcus', 'dee']);
  });

  it('a handle (id) still works unchanged', async () => {
    expect(staffIds((await run('scheduling.list_staff', { serviceId: 'beard' })).result)).toEqual(['marcus']);
  });

  it('an ambiguous name fails with every candidate as {serviceId, name}', async () => {
    // "Skin fade" is a service's name here and one of Fade's aliases.
    const own = [...SHARP_LINE, seededService('skin', null, 'Skin fade', [])];
    const error = errorOf((await run('scheduling.list_staff', { serviceId: 'skin fade' }, tenants(own))).result);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'serviceId',
      callerSafeMessage: 'We have more than one service by that name. Which one did you mean?',
    });
    expect(error.alternatives).toEqual([
      { serviceId: 'skin', name: 'Skin fade' },
      { serviceId: 'fade', name: 'Fade' },
    ]);
  });

  it('an unknown name stays NOT_FOUND, with the closest services as suggestions', async () => {
    const error = errorOf((await run('scheduling.list_staff', { serviceId: 'low fade please' })).result);
    expect(error).toMatchObject({ code: 'NOT_FOUND', field: 'serviceId', callerSafeMessage: "I couldn't find that service." });
    expect(error.message).toMatch(/^Unknown service: low fade please\./);
    const alternatives = error.alternatives as { serviceId: string; name: string }[];
    expect(alternatives[0]).toEqual({ serviceId: 'fade', name: 'Fade' });
    expect(alternatives.length).toBeGreaterThan(1);
    expect(alternatives.length).toBeLessThanOrEqual(4);
  });

  it("never resolves another tenant's service, by id or by name, nor suggests it", async () => {
    for (const ref of ['perm', 'Perm', 'permanente', 'other-fade']) {
      const { result, query } = await run('scheduling.list_staff', { serviceId: ref });
      const error = errorOf(result);
      expect(error.code).toBe('NOT_FOUND');
      const suggested = (error.alternatives as { serviceId: string }[]).map((a) => a.serviceId);
      expect(suggested.some((id) => ['perm', 'other-fade'].includes(id))).toBe(false);
      for (const [sql, values] of query.mock.calls.filter(([sql]) => /\bFROM\b/.test(sql))) {
        expect(sql).toMatch(/WHERE tenant_id = \$1/);
        expect(values?.[0]).toBe(TENANT);
      }
    }
  });

  it('answers in Spanish for a Spanish call', async () => {
    const error = errorOf((await run('scheduling.list_staff', { serviceId: 'manicura' }, tenants(), { locale: 'es-US' })).result);
    expect(error.callerSafeMessage).toBe('No encontré ese servicio.');
  });
});

describe('scheduling.check_availability with service names', () => {
  const input = { staffId: 'any', date: '2026-10-20' };

  it('finds slots for serviceIds:["Fade"]', async () => {
    const { result } = await run('scheduling.check_availability', { ...input, serviceIds: ['Fade'] });
    expect(result.ok).toBe(true);
    expect(result.ok && (result.data as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
  });

  it('gives the same slots for the name, the Spanish alias and the id', async () => {
    const byId = (await run('scheduling.check_availability', { ...input, serviceIds: ['fade'] })).result;
    const byName = (await run('scheduling.check_availability', { ...input, serviceIds: ['Fade'] })).result;
    const byAlias = (await run('scheduling.check_availability', { ...input, serviceIds: ['degradado'] })).result;
    expect(byName).toEqual(byId);
    expect(byAlias).toEqual(byId);
  });

  it('resolves a mix of ids and names, and refuses the same service twice', async () => {
    const mixed = (await run('scheduling.check_availability', { ...input, serviceIds: ['Fade', 'beard'] })).result;
    expect(mixed.ok).toBe(true);
    const twice = errorOf((await run('scheduling.check_availability', { ...input, serviceIds: ['Fade', 'fade'] })).result);
    expect(twice).toMatchObject({ code: 'VALIDATION_FAILED', field: 'serviceIds', message: 'Each service may appear once' });
  });

  it('an unknown name is NOT_FOUND with suggestions; an ambiguous one lists candidates', async () => {
    const unknown = errorOf((await run('scheduling.check_availability', { ...input, serviceIds: ['perm'] })).result);
    expect(unknown).toMatchObject({ code: 'NOT_FOUND', field: 'serviceIds' });
    expect((unknown.alternatives as unknown[]).length).toBeGreaterThan(0);
    const own = [...SHARP_LINE, seededService('skin', null, 'Skin fade', [])];
    const ambiguous = errorOf((await run('scheduling.check_availability', { ...input, serviceIds: ['Skin Fade'] }, tenants(own))).result);
    expect(ambiguous).toMatchObject({ code: 'VALIDATION_FAILED', field: 'serviceIds' });
    expect((ambiguous.alternatives as { serviceId: string }[]).map((a) => a.serviceId)).toEqual(['skin', 'fade']);
  });
});

describe('book.prepare slot scope (write path)', () => {
  async function scope(serviceIds: string[], own: Rows = SHARP_LINE) {
    return slotScope(txFor(tenants(own)).tx, ctx(), { serviceIds, staffId: 'any' });
  }

  it('resolves an exact name or alias to the service, so the hold stores its id', async () => {
    for (const ref of ['Fade', 'degradado', 'fade']) {
      const found = await scope([ref]);
      expect(isActionFailure(found)).toBe(false);
      if (!isActionFailure(found)) expect(found.services.map((s) => s.id)).toEqual(['fade']);
    }
  });

  it('never guesses past an exact name or alias: a sentence naming a fade is refused, with Fade suggested', async () => {
    const found = await scope(['fade on saturday']);
    expect(isActionFailure(found)).toBe(true);
    const error = isActionFailure(found) && !found.ok ? found.error : null;
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'serviceIds', callerSafeMessage: "I couldn't find that service." });
    expect(error?.message).toMatch(/^Unknown or inactive service: fade on saturday\./);
    expect((error?.alternatives as { serviceId: string }[])[0].serviceId).toBe('fade');
  });

  it('refuses an ambiguous name instead of picking one', async () => {
    const found = await scope(['skin fade'], [...SHARP_LINE, seededService('skin', null, 'Skin fade', [])]);
    expect(isActionFailure(found) && !found.ok && found.error.code).toBe('VALIDATION_FAILED');
    expect(isActionFailure(found) && !found.ok && (found.error.alternatives as unknown[]).length).toBe(2);
  });

  it("refuses another tenant's service", async () => {
    const found = await scope(['Perm']);
    expect(isActionFailure(found)).toBe(true);
  });
});
