import { describe, expect, it } from 'vitest';
import { FakeToolProvider, formatLocalHm, localDate, resetFakeTokens, slotStartMatches } from './fakeToolProvider';
import { buildFixture } from './seed';
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
});
