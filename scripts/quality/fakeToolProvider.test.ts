import { describe, expect, it } from 'vitest';
import { ShopFixtureStore } from '../../tests/quality/fixtures/shopFixtures';
import {
  FakeToolProvider,
  FIND_LIMIT,
  formatLocalHm,
  localDate,
  resetFakeTokens,
  slotStartMatches,
  type CatalogService,
} from './fakeToolProvider';
import { buildFixture, snapshotOf } from './seed';
import type { ToolCallContext } from './types';

function ctx(now = '2026-10-20T14:00:00-04:00'): ToolCallContext {
  return {
    tenantId: 't',
    actor: { type: 'agent', id: 'sim' },
    now: new Date(now),
    tenantTimezone: 'America/New_York',
    callId: 'c1',
  };
}

describe('FakeToolProvider', () => {
  it('holds then confirms exactly one booking at 15:30 with Marco', async () => {
    resetFakeTokens();
    const state = buildFixture('barbershop-marco');
    const tools = new FakeToolProvider(state, ['scheduling']);
    const prepare = await tools.invoke(
      'scheduling.book.prepare',
      {
        serviceIds: ['mens-cut'],
        staffId: 'marco',
        start: '2026-10-20T15:30:00-04:00',
        customer: { name: 'Luis', phone: '+15555550142' },
      },
      ctx(),
    );
    expect(prepare.ok).toBe(true);
    if (!prepare.ok) return;
    expect(prepare.readback).toMatch(/Marco/);
    const commit = await tools.invoke(
      'scheduling.book.commit',
      { confirmationToken: (prepare.data as { confirmationToken: string }).confirmationToken },
      ctx(),
    );
    expect(commit.ok).toBe(true);
    const confirmed = state.bookings.filter((row) => row.status === 'confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].staffId).toBe('marco');
    expect(confirmed[0].startLocal).toBe('15:30');
    expect(formatLocalHm(confirmed[0].start, 'America/New_York')).toBe('15:30');
  });

  it('reports fully_booked when anyone asks for today and no slots remain', async () => {
    const state = buildFixture('barbershop-fully-booked-today');
    const tools = new FakeToolProvider(state, ['scheduling']);
    const result = await tools.invoke(
      'scheduling.check_availability',
      { serviceIds: ['mens-cut'], staffId: 'any', date: '2026-10-20' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ slots: [], reasonIfNone: 'fully_booked', nextOpenDate: '2026-10-21' });
  });

  it('rejects tools the template did not enable', async () => {
    const tools = new FakeToolProvider(buildFixture('barbershop-marco'), ['scheduling']);
    const result = await tools.invoke('calls.transfer_to_human.prepare', { target: 'Dana' }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOOL_NOT_ENABLED');
  });

  it('does not offer or book a service the staff member does not perform', async () => {
    const state = buildFixture('barbershop-marco');
    const tools = new FakeToolProvider(state, ['scheduling']);
    const availability = await tools.invoke(
      'scheduling.check_availability',
      { serviceIds: ['beard'], staffId: 'dana', date: '2026-10-20' },
      ctx(),
    );
    expect(availability.ok).toBe(true);
    if (!availability.ok) return;
    expect(availability.data).toMatchObject({ slots: [] });
    const prepare = await tools.invoke(
      'scheduling.book.prepare',
      {
        serviceIds: ['beard'],
        staffId: 'dana',
        start: '2026-10-20T16:00:00-04:00',
        customer: { name: 'Luis', phone: '+15555550142' },
      },
      ctx(),
    );
    expect(prepare.ok).toBe(false);
    if (prepare.ok) return;
    expect(prepare.error.code).toBe('CONFLICT');
    expect(state.bookings).toHaveLength(0);
  });

  it('books a bare HH:MM start only on the scenario date', async () => {
    resetFakeTokens();
    const today = new FakeToolProvider(buildFixture('barbershop-marco'), ['scheduling']);
    const sameDay = await today.invoke(
      'scheduling.book.prepare',
      {
        serviceIds: ['mens-cut'],
        staffId: 'marco',
        start: '15:30',
        customer: { name: 'Luis', phone: '+15555550142' },
      },
      ctx('2026-10-20T14:00:00-04:00'),
    );
    expect(sameDay.ok).toBe(true);

    const otherDay = new FakeToolProvider(buildFixture('barbershop-marco'), ['scheduling']);
    const nextDay = await otherDay.invoke(
      'scheduling.book.prepare',
      {
        serviceIds: ['mens-cut'],
        staffId: 'marco',
        start: '15:30',
        customer: { name: 'Luis', phone: '+15555550142' },
      },
      ctx('2026-10-21T14:00:00-04:00'),
    );
    expect(nextDay.ok).toBe(false);
  });

  it('accepts only a full timestamp or exact local HH:MM on the scenario date', async () => {
    const tz = 'America/New_York';
    expect(slotStartMatches('2026-10-20T15:30:00-04:00', '2026-10-20T15:30:00-04:00', tz)).toBe(true);
    expect(slotStartMatches('2026-10-20T15:30:00-04:00', '15:30', tz, '2026-10-20')).toBe(true);
    expect(slotStartMatches('2026-10-21T15:30:00-04:00', '15:30', tz, '2026-10-20')).toBe(false);
    expect(slotStartMatches('2026-10-20T15:30:00-04:00', '15:30', tz)).toBe(false);
    expect(slotStartMatches('2026-10-20T15:30:00-04:00', '15', tz, '2026-10-20')).toBe(false);
    expect(slotStartMatches('2026-10-20T15:30:00-04:00', '2026-10-20', tz, '2026-10-20')).toBe(false);
    expect(slotStartMatches('2026-10-20T15:30:00-04:00', '-04:00', tz, '2026-10-20')).toBe(false);
    expect(localDate('2026-10-20T15:30:00-04:00', tz)).toBe('2026-10-20');
    const tools = new FakeToolProvider(buildFixture('barbershop-marco'), ['scheduling']);
    const prepare = await tools.invoke(
      'scheduling.book.prepare',
      {
        serviceIds: ['mens-cut'],
        staffId: 'marco',
        start: '15',
        customer: { name: 'Luis', phone: '+15555550142' },
      },
      ctx(),
    );
    expect(prepare.ok).toBe(false);
  });

  const LUIS = { name: 'Luis', phone: '+15555550142' };
  const tokenOf = (result: Awaited<ReturnType<FakeToolProvider['invoke']>>) =>
    (result.ok ? (result.data as { confirmationToken: string }).confirmationToken : '');

  it('releases the call\'s earlier hold on a new prepare; the old token no longer commits', async () => {
    resetFakeTokens();
    const state = buildFixture('barbershop-marco');
    const tools = new FakeToolProvider(state, ['scheduling']);
    const first = await tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'marco', start: '2026-10-20T15:30:00-04:00', customer: LUIS }, ctx());
    // Another call's hold survives this call's correction.
    const other = await tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'dana', start: '2026-10-20T16:00:00-04:00', customer: LUIS }, { ...ctx(), callId: 'c2' });
    const second = await tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'marco', start: '2026-10-20T15:30:00-04:00', customer: LUIS }, ctx());
    expect([first.ok, other.ok, second.ok]).toEqual([true, true, true]);
    expect(state.bookings.map((row) => [row.staffId, row.status, row.cancellationReason])).toEqual([
      ['marco', 'cancelled', 'hold_superseded'],
      ['dana', 'held', undefined],
      ['marco', 'held', undefined],
    ]);
    const stale = await tools.invoke('scheduling.book.commit', { confirmationToken: tokenOf(first) }, ctx());
    expect(stale.ok ? null : stale.error.code).toBe('CONFIRMATION_INVALID');
    expect((await tools.invoke('scheduling.book.commit', { confirmationToken: tokenOf(second) }, ctx())).ok).toBe(true);
    expect(snapshotOf(state).bookings.map((row) => [row.staffId, row.status])).toEqual([
      ['dana', 'held'],
      ['marco', 'confirmed'],
    ]);
  });

  describe('find_bookings / reschedule / cancel (spec §0.2.6)', () => {
    const PHONE = '+15555550142';
    /** barbershop-marco plus Luis's Thursday 10:00 with Marco; caller ID as given. */
    function shop(callerNumber: string | null, extra: Partial<ReturnType<typeof buildFixture>> = {}) {
      const state = buildFixture('barbershop-marco');
      state.slots.push({ start: '2026-10-23T13:00:00-04:00', end: '2026-10-23T13:30:00-04:00', staffId: 'marco' });
      state.bookings.push({
        id: 'bk_thu', status: 'confirmed', staffId: 'marco', staffName: 'Marco', serviceIds: ['mens-cut'],
        start: '2026-10-22T10:00:00-04:00', startLocal: '10:00', customerName: 'Luis', customerPhone: PHONE,
      });
      Object.assign(state, { callerNumber, ...extra });
      return { state, tools: new FakeToolProvider(state, ['scheduling']) };
    }
    const dataOf = (result: Awaited<ReturnType<FakeToolProvider['invoke']>>) => (result.ok ? (result.data as Record<string, unknown>) : null);
    const codeOf = (result: Awaited<ReturnType<FakeToolProvider['invoke']>>) => (result.ok ? 'ok' : result.error.code);

    const ASK_NAME = { verified: false, bookings: [], askId: 'ask.bookingName', callerSafeMessage: 'What name is the appointment under?' };
    const EXIT = { verified: false, bookings: [], askId: 'ask.bookingName', callerSafeMessage: 'I can take a message so someone can call you back.', exit: 'message_ticket' };

    it('caller-ID match: the name verifies; no name reveals nothing, not even a count (booking.find@1)', async () => {
      const { state, tools } = shop(PHONE);
      const asked = dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE }, ctx()));
      expect(asked).toEqual({ ...ASK_NAME, needs: 'name' });
      expect(asked).not.toHaveProperty('matchCount');
      const found = dataOf(await tools.invoke('scheduling.find_bookings', { phone: '555-555-0142', name: 'luis' }, ctx()));
      expect(found).toMatchObject({ verified: true, bookings: [{ bookingId: 'bk_thu', staffName: 'Marco', end: '2026-10-22T14:30:00.000Z' }] });
      expect(snapshotOf(state).disclosed).toEqual(['bk_thu']);
    });

    it('a wrong name is one ask; the second miss exits to a message and nothing matches after', async () => {
      const { state, tools } = shop(PHONE);
      expect(dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Ana' }, ctx()))).toEqual({ ...ASK_NAME, needs: 'name' });
      expect(dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Carla' }, ctx()))).toEqual({ ...EXIT, needs: 'name' });
      // After the exit, even the right name finds nothing in this call.
      expect(dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx()))).toEqual({ ...EXIT, needs: 'name' });
      expect(snapshotOf(state).disclosed).toEqual([]);
      // Another call starts fresh.
      expect(dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, { ...ctx(), callId: 'c2' }))).toMatchObject({ verified: true });
    });

    it('different or blocked caller ID: needs name + date + time, and never says how many', async () => {
      for (const callerNumber of ['+15555550199', null]) {
        const { tools } = shop(callerNumber);
        const refused = { verified: false, bookings: [], needs: 'name_date_time' };
        // The date is the first missing slot, then a wrong time is a miss of the name check.
        expect(dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx()))).toEqual({
          ...refused,
          askId: 'ask.bookingDate',
          callerSafeMessage: 'What day is the appointment?',
        });
        expect(dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis', date: '2026-10-22', time: '10:30' }, ctx()))).toEqual({ ...refused, ...ASK_NAME });
        const found = await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis', date: '2026-10-22', time: '10:00' }, ctx());
        expect(dataOf(found)).toMatchObject({ verified: true, bookings: [{ bookingId: 'bk_thu' }] });
      }
    });

    it('reschedule/cancel only a booking verified in the same call', async () => {
      resetFakeTokens();
      const { state, tools } = shop(PHONE);
      const move = { bookingId: 'bk_thu', newStart: '2026-10-23T13:00:00-04:00' };
      expect(codeOf(await tools.invoke('scheduling.reschedule.prepare', move, ctx()))).toBe('NOT_FOUND');
      await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx());
      expect(codeOf(await tools.invoke('scheduling.cancel.prepare', { bookingId: 'bk_thu' }, { ...ctx(), callId: 'c2' }))).toBe('NOT_FOUND');
      const prepared = await tools.invoke('scheduling.reschedule.prepare', move, ctx());
      expect(prepared.ok && prepared.readback).toBe("Moving Luis's men's cut from Thursday, October 22 at 10:00 AM with Marco to Friday, October 23 at 1:00 PM with Marco.");
      expect(codeOf(await tools.invoke('scheduling.reschedule.commit', { confirmationToken: tokenOf(prepared) }, { ...ctx(), callId: 'c2' }))).toBe('CONFIRMATION_INVALID');
      expect(codeOf(await tools.invoke('scheduling.reschedule.commit', { confirmationToken: tokenOf(prepared) }, ctx()))).toBe('ok');
      expect(snapshotOf(state).bookings.map((row) => [row.status, row.start])).toEqual([['confirmed', '2026-10-23T13:00:00-04:00']]);
      expect(state.bookings.find((row) => row.id === 'bk_thu')?.status).toBe('rescheduled');
    });

    it('a booking staff re-assigned after the find (name or phone) is NOT_FOUND', async () => {
      for (const change of [{ customerName: 'Ana' }, { customerPhone: '+15555550188' }]) {
        const { state, tools } = shop(PHONE);
        await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx());
        Object.assign(state.bookings.find((row) => row.id === 'bk_thu')!, change);
        expect(codeOf(await tools.invoke('scheduling.cancel.prepare', { bookingId: 'bk_thu' }, ctx()))).toBe('NOT_FOUND');
      }
    });

    it('an agent commit after staff changed the name or phone since the prepare is CONFLICT and changes nothing', async () => {
      const move = { bookingId: 'bk_thu', newStart: '2026-10-23T13:00:00-04:00' };
      for (const change of [{ customerName: 'Ana' }, { customerPhone: '+15555550188' }]) {
        const { state, tools } = shop(PHONE);
        await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx());
        const cancel = await tools.invoke('scheduling.cancel.prepare', { bookingId: 'bk_thu' }, ctx());
        const moved = await tools.invoke('scheduling.reschedule.prepare', move, ctx());
        Object.assign(state.bookings.find((row) => row.id === 'bk_thu')!, change);
        expect(codeOf(await tools.invoke('scheduling.cancel.commit', { confirmationToken: tokenOf(cancel) }, ctx()))).toBe('CONFLICT');
        expect(codeOf(await tools.invoke('scheduling.reschedule.commit', { confirmationToken: tokenOf(moved) }, ctx()))).toBe('CONFLICT');
        expect(state.bookings.map((row) => row.status)).toEqual(['confirmed', 'held']);
      }
    });

    it('keeps the policy (window, already passed) and offers alternatives for a taken slot', async () => {
      const { state, tools } = shop(PHONE);
      state.bookings.push({
        id: 'bk_ana', status: 'confirmed', staffId: 'marco', staffName: 'Marco', serviceIds: ['mens-cut'],
        start: '2026-10-23T13:00:00-04:00', startLocal: '13:00', customerName: 'Ana', customerPhone: '+15555550188',
      });
      await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx());
      const taken = await tools.invoke('scheduling.reschedule.prepare', { bookingId: 'bk_thu', newStart: '2026-10-23T13:00:00-04:00' }, ctx());
      expect(taken.ok ? null : taken.error).toMatchObject({ code: 'CONFLICT', callerSafeMessage: "That time isn't available. I can offer the closest open times." });
      const window = await tools.invoke('scheduling.cancel.prepare', { bookingId: 'bk_thu' }, ctx('2026-10-21T14:00:00-04:00'));
      expect(window.ok ? null : window.error.callerSafeMessage).toMatch(/24 hours' notice/);
      const passed = await tools.invoke('scheduling.cancel.prepare', { bookingId: 'bk_thu' }, ctx('2026-10-22T10:05:00-04:00'));
      expect(passed.ok ? null : passed.error).toMatchObject({ code: 'OUTSIDE_POLICY', callerSafeMessage: expect.stringMatching(/already started or passed/) });
    });

    it('reschedule free check compares full time ranges, not only start times', async () => {
      // Ana's 45-minute combo with Marco runs 12:45-13:30; the 13:00 slot starts inside it.
      const { state, tools } = shop(PHONE);
      state.services.push({ id: 'combo', name: 'cut and beard combo', durationMin: 45, priceText: '$50' });
      state.staff.find((member) => member.id === 'marco')!.serviceIds.push('combo');
      state.slots.push({ start: '2026-10-23T14:00:00-04:00', end: '2026-10-23T14:30:00-04:00', staffId: 'marco' });
      state.bookings.push({
        id: 'bk_ana', status: 'confirmed', staffId: 'marco', staffName: 'Marco', serviceIds: ['combo'],
        start: '2026-10-23T12:45:00-04:00', startLocal: '12:45', customerName: 'Ana', customerPhone: '+15555550188',
      });
      await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx());
      const overlapping = await tools.invoke('scheduling.reschedule.prepare', { bookingId: 'bk_thu', newStart: '2026-10-23T13:00:00-04:00' }, ctx());
      expect(overlapping.ok ? null : overlapping.error).toMatchObject({
        code: 'CONFLICT',
        alternatives: [{ start: '2026-10-23T14:00:00-04:00', staffId: 'marco' }],
      });

      // Back to back is free: a 30-minute move ending exactly when the next booking starts.
      state.bookings.find((row) => row.id === 'bk_ana')!.start = '2026-10-23T13:30:00-04:00';
      const adjacent = await tools.invoke('scheduling.reschedule.prepare', { bookingId: 'bk_thu', newStart: '2026-10-23T13:00:00-04:00' }, ctx());
      expect(adjacent.ok).toBe(true);
    });

    it('a new start inside a booking that started earlier the same day is taken (staff-scoped)', async () => {
      const { state, tools } = shop(PHONE);
      state.slots.push({ start: '2026-10-23T13:15:00-04:00', end: '2026-10-23T13:45:00-04:00', staffId: 'marco' });
      state.slots.push({ start: '2026-10-23T13:15:00-04:00', end: '2026-10-23T13:45:00-04:00', staffId: 'dana' });
      state.bookings.push({
        id: 'bk_ana', status: 'held', staffId: 'marco', staffName: 'Marco', serviceIds: ['mens-cut'],
        start: '2026-10-23T13:00:00-04:00', startLocal: '13:00', customerName: 'Ana', customerPhone: '+15555550188',
      });
      await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx());
      const marco = await tools.invoke('scheduling.reschedule.prepare', { bookingId: 'bk_thu', newStart: '2026-10-23T13:15:00-04:00' }, ctx());
      expect(codeOf(marco)).toBe('CONFLICT');
      const dana = await tools.invoke('scheduling.reschedule.prepare', { bookingId: 'bk_thu', newStart: '2026-10-23T13:15:00-04:00', staffId: 'dana' }, ctx());
      expect(codeOf(dana)).toBe('ok');
    });

    it(`find_bookings returns at most FIND_LIMIT (${FIND_LIMIT}) bookings, like the real action`, async () => {
      const { state, tools } = shop(PHONE);
      for (let day = 0; day < 25; day += 1) {
        const date = new Date(Date.UTC(2026, 9, 26 + day, 14, 0));
        state.bookings.push({
          id: `bk_many_${day}`, status: 'confirmed', staffId: 'marco', staffName: 'Marco', serviceIds: ['mens-cut'],
          start: date.toISOString(), startLocal: '10:00', customerName: 'Luis', customerPhone: PHONE,
        });
      }
      const found = dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE, name: 'Luis' }, ctx())) as { bookings: Array<{ bookingId: string }> };
      expect(found.bookings).toHaveLength(FIND_LIMIT);
      // Soonest first: Thursday's booking, then the earliest of the 25.
      expect(found.bookings[0].bookingId).toBe('bk_thu');
      expect(found.bookings[1].bookingId).toBe('bk_many_0');
      // Only the returned bookings are verified for a change in this call.
      expect(codeOf(await tools.invoke('scheduling.cancel.prepare', { bookingId: 'bk_many_24' }, ctx()))).toBe('NOT_FOUND');
      expect(codeOf(await tools.invoke('scheduling.cancel.prepare', { bookingId: 'bk_many_18' }, ctx()))).toBe('ok');
      // Trusted (non-agent) lookups are capped too; the uncapped count is never listed.
      const staff = dataOf(await tools.invoke('scheduling.find_bookings', { phone: PHONE }, { ...ctx(), actor: { type: 'user', id: 'u1' } })) as { bookings: unknown[] };
      expect(staff.bookings).toHaveLength(FIND_LIMIT);
    });
  });

  it('check_availability and book.prepare compare full time ranges, not only start times', async () => {
    resetFakeTokens();
    const state = buildFixture('barbershop-marco');
    // Ana's 45-minute cut + beard with Marco runs 15:00-15:45; the 15:30 slot starts inside it.
    state.bookings.push({
      id: 'bk_ana', status: 'confirmed', staffId: 'marco', staffName: 'Marco', serviceIds: ['mens-cut', 'beard'],
      start: '2026-10-20T15:00:00-04:00', startLocal: '15:00', customerName: 'Ana', customerPhone: '+15555550188',
    });
    const tools = new FakeToolProvider(state, ['scheduling']);
    const availability = await tools.invoke('scheduling.check_availability', { serviceIds: ['mens-cut'], staffId: 'marco', date: '2026-10-20' }, ctx());
    expect(availability.ok && availability.data).toMatchObject({ slots: [] });
    const prepare = await tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'marco', start: '2026-10-20T15:30:00-04:00', customer: LUIS }, ctx());
    expect(prepare.ok ? null : prepare.error.code).toBe('CONFLICT');
    // Back to back is free: Ana's booking moved to end exactly at 15:30.
    state.bookings[0].start = '2026-10-20T14:45:00-04:00';
    const adjacent = await tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'marco', start: '2026-10-20T15:30:00-04:00', customer: LUIS }, ctx());
    expect(adjacent.ok).toBe(true);
  });

  describe('service buffers block like the availability engine (end + largest buffer, both sides)', () => {
    const at = (hm: string) => `2026-10-22T${hm}:00-04:00`;
    // Marco's 10:00-10:30 men's cut with a 15-minute buffer blocks him through 10:45.
    const bufferedShop = (bufferMin = 15) => {
      resetFakeTokens();
      const state = buildFixture('barbershop-marco');
      state.services = state.services.map((service) => (service.id === 'mens-cut' ? { ...service, bufferMin } : service));
      state.slots = ['09:15', '09:30', '10:30', '10:45'].map((hm) => ({ start: at(hm), end: at(hm), staffId: 'marco' }));
      state.bookings.push(
        { id: 'bk_ten', status: 'confirmed', staffId: 'marco', staffName: 'Marco', serviceIds: ['mens-cut'], start: at('10:00'), startLocal: '10:00', customerName: 'Ana', customerPhone: '+15555550188' },
        { id: 'bk_fri', status: 'confirmed', staffId: 'marco', staffName: 'Marco', serviceIds: ['mens-cut'], start: '2026-10-23T15:00:00-04:00', startLocal: '15:00', customerName: 'Ana', customerPhone: '+15555550188' },
      );
      return { state, tools: new FakeToolProvider(state, ['scheduling']) };
    };
    const staffCtx = (): ToolCallContext => ({ ...ctx(), actor: { type: 'user', id: 'u1' } });
    const starts = (result: Awaited<ReturnType<FakeToolProvider['invoke']>>) =>
      result.ok ? (result.data as { slots: Array<{ start: string }> }).slots.map((slot) => formatLocalHm(slot.start, 'America/New_York')) : null;
    const book = (tools: FakeToolProvider, hm: string) =>
      tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'marco', start: at(hm), customer: LUIS }, ctx());
    const move = (tools: FakeToolProvider, hm: string) =>
      tools.invoke('scheduling.reschedule.prepare', { bookingId: 'bk_fri', newStart: at(hm) }, staffCtx());

    it('check_availability: 10:30 is not offered, 10:45 is; 9:30 is not (its own buffer runs to 10:15)', async () => {
      const { tools } = bufferedShop();
      const availability = await tools.invoke('scheduling.check_availability', { serviceIds: ['mens-cut'], staffId: 'marco', date: '2026-10-22' }, ctx());
      expect(starts(availability)).toEqual(['09:15', '10:45']);
      // With no buffer the back-to-back starts are free again.
      const unbuffered = await bufferedShop(0).tools.invoke('scheduling.check_availability', { serviceIds: ['mens-cut'], staffId: 'marco', date: '2026-10-22' }, ctx());
      expect(starts(unbuffered)).toEqual(['09:15', '09:30', '10:30', '10:45']);
    });

    it('book.prepare: 10:30 is CONFLICT, 10:45 is held; the read-back end stays duration only', async () => {
      expect((await book(bufferedShop().tools, '10:30')).ok ? null : 'CONFLICT').toBe('CONFLICT');
      expect((await book(bufferedShop().tools, '09:30')).ok ? null : 'CONFLICT').toBe('CONFLICT');
      expect((await book(bufferedShop().tools, '10:45')).ok).toBe(true);
      const found = await bufferedShop().tools.invoke('scheduling.find_bookings', { phone: '+15555550188' }, staffCtx());
      expect(found.ok && (found.data as { bookings: Array<{ bookingId: string; end: string }> }).bookings[0]).toMatchObject({
        bookingId: 'bk_ten',
        end: new Date(at('10:30')).toISOString(),
      });
    });

    it('reschedule.prepare: 10:30 is CONFLICT (no buffered alternative offered), 10:45 is held', async () => {
      const refused = await move(bufferedShop().tools, '10:30');
      expect(refused.ok ? null : refused.error).toMatchObject({ code: 'CONFLICT' });
      const alternatives = refused.ok ? [] : (refused.error.alternatives as Array<{ start: string }>);
      expect(alternatives.map((slot) => formatLocalHm(slot.start, 'America/New_York'))).toEqual(['09:15', '10:45']);
      const moved = await move(bufferedShop().tools, '10:45');
      expect(moved.ok && moved.data).toMatchObject({ start: at('10:45'), end: new Date(at('11:15')).toISOString() });
    });

    it('the shop fixtures carry each service buffer into the state', () => {
      const services = new ShopFixtureStore('barbershop-basic').state.services as CatalogService[];
      expect(services.length).toBeGreaterThan(0);
      expect(services.every((service) => typeof service.bufferMin === 'number')).toBe(true);
    });
  });

  describe('tickets.message@1 and the hangup floor', () => {
    const dataOf = (result: Awaited<ReturnType<FakeToolProvider['invoke']>>) => (result.ok ? (result.data as Record<string, unknown>) : null);
    const MESSAGE = { kind: 'message', subject: 'Ask about a standing cut', customer: { name: 'Luis' } };
    const system: Partial<ToolCallContext> = { actor: { type: 'system', id: 'voice-runtime' } };
    const shopWith = (callerNumber: string | null) => {
      const state = buildFixture('barbershop-marco');
      state.callerNumber = callerNumber;
      return { state, tools: new FakeToolProvider(state, ['scheduling', 'tickets']) };
    };
    const floor = (tools: FakeToolProvider, callerLines: string[], extra: Record<string, unknown> = {}) =>
      tools.invoke('tickets.file_floor', { callId: 'c1', callerLines, ...extra }, { ...ctx(), ...system });

    it('holds the callback number from caller ID: no ask', async () => {
      const { state, tools } = shopWith('+15555550142');
      const prepare = await tools.invoke('tickets.open.prepare', MESSAGE, ctx());
      expect(prepare.ok).toBe(true);
      expect(state.tickets).toMatchObject([{ kind: 'message', phone: '+15555550142', callId: 'c1', status: 'held' }]);
    });

    it('caller ID hidden: asks for the number once, then prepares without one', async () => {
      const { state, tools } = shopWith(null);
      const asked = await tools.invoke('tickets.open.prepare', MESSAGE, ctx());
      expect(asked.ok ? null : asked.error).toMatchObject({ code: 'SLOT_MISSING', askId: 'ask.callbackNumber', retryable: false });
      expect(state.tickets).toHaveLength(0);
      const filed = await tools.invoke('tickets.open.prepare', MESSAGE, ctx());
      expect(filed.ok && filed.readback).toMatch(/with no callback number$/);
      expect(state.tickets).toMatchObject([{ kind: 'message', phone: '' }]);
    });

    it('a missing subject is asked once, then exits to a message without a second ask', async () => {
      const { tools } = shopWith('+15555550142');
      const noSubject = { kind: 'message', customer: { name: 'Luis' } };
      const first = await tools.invoke('tickets.open.prepare', noSubject, ctx());
      expect(first.ok ? null : first.error).toMatchObject({ code: 'SLOT_MISSING', askId: 'ask.messageSubject' });
      const second = await tools.invoke('tickets.open.prepare', noSubject, ctx());
      expect(second.ok ? null : second.error).toMatchObject({ code: 'SLOT_MISSING', exit: 'message_ticket' });
    });

    it('floor: system only; never_heard, nothing_substantive, filed once, then already_filed', async () => {
      const { state, tools } = shopWith('+15555550142');
      const forbidden = await tools.invoke('tickets.file_floor', { callId: 'c1', callerLines: ['cancel my cut'] }, ctx());
      expect(forbidden.ok ? null : forbidden.error.code).toBe('FORBIDDEN');
      expect(dataOf(await floor(tools, ['  ']))).toEqual({ filed: false, reason: 'never_heard' });
      expect(dataOf(await floor(tools, ['Hi, this is Luis Garcia.']))).toEqual({ filed: false, reason: 'nothing_substantive' });
      const filed = await floor(tools, ['Hi, I need a beard trim with Marco on Friday']);
      expect(dataOf(filed)).toMatchObject({ filed: true, reason: 'filed' });
      expect(dataOf(await floor(tools, ['Hi, I need a beard trim with Marco on Friday']))).toEqual({ filed: false, reason: 'already_filed' });
      expect(state.tickets).toMatchObject([{ kind: 'message', floor: true, phone: '+15555550142', status: 'open', callId: 'c1' }]);
    });

    it('floor: a booking or ticket the call committed is an artifact; a hold is not', async () => {
      resetFakeTokens();
      const { state, tools } = shopWith('+15555550142');
      const prepare = await tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'marco', start: '2026-10-20T15:30:00-04:00', customer: LUIS }, ctx());
      expect(dataOf(await floor(tools, ['A cut with Marco at 3:30 please']))).toMatchObject({ filed: true });
      state.tickets.length = 0;
      await tools.invoke('scheduling.book.commit', { confirmationToken: tokenOf(prepare) }, ctx());
      expect(dataOf(await floor(tools, ['A cut with Marco at 3:30 please']))).toEqual({ filed: false, reason: 'already_filed' });
    });
  });

  it('replays a commit retried with the same token instead of failing it', async () => {
    resetFakeTokens();
    const state = buildFixture('barbershop-marco');
    const tools = new FakeToolProvider(state, ['scheduling']);
    const prepare = await tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'marco', start: '2026-10-20T15:30:00-04:00', customer: LUIS }, ctx());
    const first = await tools.invoke('scheduling.book.commit', { confirmationToken: tokenOf(prepare) }, ctx());
    const retry = await tools.invoke('scheduling.book.commit', { confirmationToken: tokenOf(prepare) }, ctx());
    expect(first.ok).toBe(true);
    expect(retry).toEqual(first);
    expect(state.bookings.filter((row) => row.status === 'confirmed')).toHaveLength(1);
  });

  it('refuses a committed token replayed from another call (runAction hashes the callId): IDEMPOTENCY_KEY_REUSED', async () => {
    resetFakeTokens();
    const state = buildFixture('barbershop-marco');
    const tools = new FakeToolProvider(state, ['scheduling']);
    const prepare = await tools.invoke('scheduling.book.prepare', { serviceIds: ['mens-cut'], staffId: 'marco', start: '2026-10-20T15:30:00-04:00', customer: LUIS }, ctx());
    const first = await tools.invoke('scheduling.book.commit', { confirmationToken: tokenOf(prepare) }, ctx());
    expect(first.ok).toBe(true);
    const other = await tools.invoke('scheduling.book.commit', { confirmationToken: tokenOf(prepare) }, { ...ctx(), callId: 'c2' });
    expect(other.ok ? null : other.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // The original call still replays its result.
    expect(await tools.invoke('scheduling.book.commit', { confirmationToken: tokenOf(prepare) }, ctx())).toEqual(first);
  });
});
