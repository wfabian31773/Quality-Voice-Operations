// scheduling.list_services `query`: spoken service text → the matching
// catalog services (name, then catalog aliases, then the EN/ES lexicon).
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, runAction, type ActionContext, type TenantTx } from '../index';
import { serviceAliases, type ServiceKey } from '../../../shared/scheduling/serviceLexicon';

const TENANT = 'tenant-sharp-line';

type Rows = Record<string, unknown>[];

/** Same names and aliases as scripts/seed-demo-barbershop.ts. */
function seededService(id: string, key: ServiceKey, name: string, priceCents: number | null) {
  return {
    id,
    name,
    duration_minutes: 30,
    buffer_minutes: 0,
    price_kind: priceCents === null ? 'hidden' : 'fixed',
    price_cents: priceCents,
    price_max_cents: null,
    aliases: serviceAliases(key).filter((a) => a.toLowerCase() !== name.toLowerCase()),
  };
}

function sharpLine(services: Rows = [
  seededService('beard', 'beard_trim', 'Beard trim', 1500),
  seededService('fade', 'fade', 'Fade', 3500),
  seededService('cut', 'haircut', 'Haircut', 3000),
  seededService('combo', 'cut_and_beard', 'Haircut and beard', 4500),
  seededService('shave', 'hot_towel_shave', 'Hot towel shave', null),
  seededService('kids', 'kids_cut', 'Kids cut', 2000),
  seededService('lineup', 'lineup', 'Lineup', 1500),
  seededService('taper', 'taper', 'Taper', 3500),
]): Record<string, Rows> {
  return {
    scheduling_appointment_types: services,
    scheduling_providers: [{ id: 'dee', name: 'Dee' }, { id: 'marcus', name: 'Marcus' }],
    scheduling_provider_services: [
      ...services.map((s) => ({ provider_id: 'marcus', appointment_type_id: s.id })),
      { provider_id: 'dee', appointment_type_id: 'fade' },
    ],
  };
}

async function list(input: unknown, data: Record<string, Rows> = sharpLine()) {
  const query = vi.fn(async (sql: string) => {
    const table = Object.keys(data).find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    const rows = table ? data[table] : [];
    return { rows, rowCount: rows.length };
  });
  const tx = { query } as TenantTx;
  const runtime = { store: createMemoryStore(), withTenantTx: async <T>(_t: string, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const ctx: ActionContext = {
    tenantId: TENANT,
    actor: { type: 'agent', id: 'agent-1' },
    now: new Date('2026-10-17T18:17:00Z'),
    tenantTimezone: 'America/New_York',
    callId: 'CA-list-services',
  };
  return runAction('scheduling.list_services', ctx, input, runtime);
}

async function namesFor(query: string, extra: Record<string, unknown> = {}, data?: Record<string, Rows>) {
  const result = await list({ query, ...extra }, data);
  expect(result.ok).toBe(true);
  return result.ok ? (result.data as { name: string }[]).map((s) => s.name) : [];
}

describe('scheduling.list_services query (alias lookup)', () => {
  it('without a query lists every service, with its aliases', async () => {
    const result = await list({});
    expect(result.ok).toBe(true);
    const data = result.ok ? (result.data as { name: string; aliases?: string[] }[]) : [];
    expect(data.map((s) => s.name)).toEqual([
      'Beard trim', 'Fade', 'Haircut', 'Haircut and beard', 'Hot towel shave', 'Kids cut', 'Lineup', 'Taper',
    ]);
    expect(data.find((s) => s.name === 'Fade')).toMatchObject({
      priceText: '$35',
      staffIds: ['marcus', 'dee'],
      aliases: expect.arrayContaining(['skin fade', 'degradado']),
    });
  });

  it.each([
    ['fade', 'Fade'],
    ['skin fade', 'Fade'],
    ['degradado', 'Fade'],
    ['Quiero un degradado', 'Fade'],
    ["I'm looking for a fade", 'Fade'],
    ['shape up', 'Lineup'],
    ['a line up', 'Lineup'],
    ['can I get a line up', 'Lineup'],
    ['corte y barba', 'Haircut and beard'],
    ["kid's haircut", 'Kids cut'],
    ['straight razor shave', 'Hot towel shave'],
  ])('"%s" → %s', async (query, name) => {
    expect(await namesFor(query)).toEqual([name]);
  });

  it('returns an empty list for a service the shop does not list', async () => {
    expect(await namesFor('pedicure')).toEqual([]);
    expect(await namesFor('balayage')).toEqual([]);
    expect(await namesFor('Saturday at 9')).toEqual([]);
  });

  it('does not read "line up an appointment" as a Lineup', async () => {
    expect(await namesFor('line up an appointment')).toEqual([]);
    expect(await namesFor("I'd like to line up an appointment for Friday")).toEqual([]);
    expect(await namesFor('line up a time')).toEqual([]);
    expect(await namesFor('line up a fade for Saturday')).toEqual(['Fade']);
  });

  it('does not read "line up" as a Lineup even when a tenant lists it as an alias', async () => {
    const data = sharpLine([
      { ...seededService('lineup', 'lineup', 'Lineup', 1500), aliases: ['line up', 'edges'] },
      seededService('fade', 'fade', 'Fade', 3500),
    ]);
    expect(await namesFor('line up an appointment', {}, data)).toEqual([]);
    expect(await namesFor('line up', {}, data)).toEqual(['Lineup']);
    expect(await namesFor('get a line up', {}, data)).toEqual(['Lineup']);
  });

  it('returns ties together so the agent asks which one', async () => {
    const data = sharpLine([
      { ...seededService('skin', 'fade', 'Skin Fade', 3500), aliases: [] },
      { ...seededService('bald', 'fade', 'Bald Fade', 4000), aliases: [] },
      seededService('cut', 'haircut', 'Haircut', 3000),
    ]);
    expect((await namesFor('low fade', {}, data)).sort()).toEqual(['Bald Fade', 'Skin Fade']);
  });

  it('combines query with staffId', async () => {
    expect(await namesFor('fade', { staffId: 'dee' })).toEqual(['Fade']);
    expect(await namesFor('beard trim', { staffId: 'dee' })).toEqual([]);
  });

  it('accepts lang and validates query and lang', async () => {
    expect(await namesFor('desvanecido', { lang: 'es' })).toEqual(['Fade']);
    for (const bad of [{ query: '' }, { query: 'x'.repeat(81) }, { query: 'fade', lang: 'fr' }]) {
      const result = await list(bad);
      expect(result.ok ? null : result.error.code).toBe('VALIDATION_FAILED');
    }
  });
});
