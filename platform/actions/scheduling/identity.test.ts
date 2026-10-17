import { describe, expect, it } from 'vitest';
import { toAgentToolSchema } from '../index';
import { findBookingsAction } from './findBookings';
import { namesMatch } from './identity';

describe('namesMatch (spec §0.2.6: the name on the booking)', () => {
  it.each([
    ['Luis', 'Luis'],
    ['luis', 'LUIS'],
    ['Luís', 'Luis'],
    ['Jose', 'José Martínez'],
    ['José Martínez', 'jose martinez'],
    ['Luis', 'Luis Garcia Jr.'],
    ['Luis Garcia', 'Luis'],
    ["O'Brien Sean", 'OBrien Sean'],
    ['  Ana   María ', 'Ana María'],
    ['Ana-María López', 'Ana María López'],
  ])('%j matches %j', (given, onBooking) => {
    expect(namesMatch(given, onBooking)).toBe(true);
  });

  it.each([
    ['Ana', 'Luis'],
    ['Luis Garcia', 'Luis Garcia Jr.'],
    ['Luis Perez', 'Luis Garcia'],
    ['Lu', 'Luis'],
    ['Garcia', 'Luis Garcia'],
    ['', 'Luis'],
    ['Luis', ''],
    ['...', '...'],
  ])('%j does not match %j', (given, onBooking) => {
    expect(namesMatch(given, onBooking)).toBe(false);
  });
});

describe('scheduling.find_bookings', () => {
  it('is an agent read with qvo:read, and its tool schema is stable', () => {
    expect(findBookingsAction).toMatchObject({ kind: 'read', permissions: { agent: true, mcpScope: 'qvo:read' } });
    expect(toAgentToolSchema(findBookingsAction)).toMatchSnapshot();
  });
});
