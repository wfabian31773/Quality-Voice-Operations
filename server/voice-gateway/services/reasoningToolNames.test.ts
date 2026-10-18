import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from './agentLoader';
import { engineSuccessToolName, engineToolCall, engineToolNames, engineVertical } from './reasoningToolNames';

function composerBinding() {
  const agent = loadAgentConfig({
    tenantId: 't-shop' as never,
    agentId: 'ag-shop',
    agentType: 'barbershop',
    callerPhone: '+15555550100',
    dbAgent: { name: 'Front desk', language: 'en', tenant_timezone: 'America/New_York', metadata: { businessName: 'Sharp Line Barbers', runtime: 'composer' } },
  });
  if (!agent.contractTools) throw new Error('composer agent expected');
  return agent.contractTools;
}

describe('reasoningToolNames (Codex 4307582062)', () => {
  it('every contract tool the barbershop composer exposes has an engine name', () => {
    const binding = composerBinding();
    const translated = Object.fromEntries(Object.keys(binding.actions).map((name) => [name, engineToolCall(name, {}, binding).toolName]));
    expect(translated).toEqual({
      scheduling_book_prepare: 'create_booking',
      scheduling_book_commit: 'create_booking',
      scheduling_find_bookings: 'lookup_customer',
      scheduling_reschedule_prepare: 'update_booking',
      scheduling_reschedule_commit: 'update_booking',
      scheduling_cancel_prepare: 'update_booking',
      scheduling_cancel_commit: 'update_booking',
      tickets_open_prepare: 'create_ticket',
      tickets_open_commit: 'create_ticket',
      scheduling_list_services: 'list_services',
      scheduling_list_staff: 'list_staff',
      scheduling_check_availability: 'check_availability',
    });
  });

  it('args take the keys the SafetyGate reads for the library tool', () => {
    const binding = composerBinding();
    expect(engineToolCall('scheduling_book_prepare', { serviceIds: ['service-1'], start: '2026-10-23T15:30:00-04:00', customer: { name: 'Luis', phone: '+15555550100' } }, binding).args)
      .toEqual({ startTime: '2026-10-23T15:30:00-04:00', contactName: 'Luis', contactPhone: '+15555550100' });
    expect(engineToolCall('scheduling_reschedule_prepare', { bookingId: 'booking-1', newStart: '2026-10-24T10:00:00-04:00' }, binding).args)
      .toEqual({ action: 'reschedule', bookingId: 'booking-1', startTime: '2026-10-24T10:00:00-04:00' });
    expect(engineToolCall('scheduling_cancel_commit', { confirmationToken: 'tok' }, binding).args).toEqual({ action: 'cancel', confirmationToken: 'tok' });
    expect(engineToolCall('tickets_open_prepare', { subject: 'Call back', details: 'About Friday', customer: { name: 'Luis' } }, binding).args)
      .toEqual({ subject: 'Call back', description: 'About Friday', contactName: 'Luis' });
  });

  it('a prepare reports success under its own name; a commit or read under the engine name', () => {
    const binding = composerBinding();
    expect(engineSuccessToolName('scheduling_book_prepare', binding)).toBe('scheduling_book_prepare');
    expect(engineSuccessToolName('scheduling_book_commit', binding)).toBe('create_booking');
    expect(engineSuccessToolName('scheduling_list_services', binding)).toBe('list_services');
  });

  it('any other agent (no contract binding) is unchanged', () => {
    const args = { title: 'Fade' };
    expect(engineToolCall('create_booking', args, undefined)).toEqual({ toolName: 'create_booking', args });
    expect(engineSuccessToolName('create_booking', undefined)).toBe('create_booking');
    expect(engineToolNames(['create_booking', 'create_ticket'], undefined)).toEqual(['create_booking', 'create_ticket']);
    expect(engineVertical('barbershop', undefined)).toBe('barbershop');
    expect(engineVertical('salon', undefined)).toBe('salon');
    expect(engineVertical(undefined, undefined)).toBe('general');
  });

  it('a composer barbershop agent runs the salon pack', () => {
    expect(engineVertical('barbershop', composerBinding())).toBe('salon');
  });
});
