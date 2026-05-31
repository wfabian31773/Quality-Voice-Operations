import { describe, it, expect } from 'vitest';
import { isDemoTenant, handleDemoToolCall } from './demoToolHandler';

function parse(json: string | null): Record<string, unknown> {
  expect(json).not.toBeNull();
  return JSON.parse(json as string);
}

describe('isDemoTenant', () => {
  it('is true only for the reserved demo tenant id', () => {
    expect(isDemoTenant('demo')).toBe(true);
    expect(isDemoTenant('tenant-1')).toBe(false);
    expect(isDemoTenant('')).toBe(false);
  });
});

describe('handleDemoToolCall', () => {
  it('returns null for a non-demo tenant (real execution must proceed)', () => {
    expect(handleDemoToolCall('tenant-1', 'createServiceTicket', {})).toBeNull();
  });

  it('returns a generic simulated response for an unknown tool', () => {
    const res = parse(handleDemoToolCall('demo', 'someNewTool', {}));
    expect(res).toMatchObject({ success: true, demo: true });
    expect(res.message).toContain('someNewTool');
  });

  it('renders the createServiceTicket script with caller-supplied fields', () => {
    const res = parse(
      handleDemoToolCall('demo', 'createServiceTicket', {
        callerName: 'Ada',
        priority: 'high',
        department: 'sales',
      }),
    );
    expect(res.success).toBe(true);
    expect(res.demo).toBe(true);
    expect(String(res.ticketId)).toMatch(/^DEMO-\d{4}$/);
    expect(res.department).toBe('sales');
    expect(res.priority).toBe('high');
    expect(String(res.confirmationMessage)).toContain('Ada');
  });

  it('falls back to defaults when fields are omitted', () => {
    const res = parse(handleDemoToolCall('demo', 'createServiceTicket', {}));
    expect(res.department).toBe('general');
    expect(res.priority).toBe('normal');
    expect(String(res.confirmationMessage)).toContain('caller');
  });

  describe('recordPaymentArrangement money formatting', () => {
    it('formats a numeric amount as USD currency', () => {
      const res = parse(handleDemoToolCall('demo', 'recordPaymentArrangement', { amount: 1247.5 }));
      expect(res.monthlyAmount).toBe(1247.5);
      expect(String(res.confirmationMessage)).toContain('$1,247.50');
    });

    it('parses a string amount', () => {
      const res = parse(handleDemoToolCall('demo', 'recordPaymentArrangement', { amount: '50.25' }));
      expect(res.monthlyAmount).toBe(50.25);
      expect(String(res.confirmationMessage)).toContain('$50.25');
    });

    it('defaults the amount when it is missing or unparseable', () => {
      const res = parse(handleDemoToolCall('demo', 'recordPaymentArrangement', {}));
      expect(res.monthlyAmount).toBe(415.83);
      expect(String(res.confirmationMessage)).toContain('$415.83');
    });
  });

  it('surfaces emergency arrival timing for createHomeServiceTicket', () => {
    const emergency = parse(handleDemoToolCall('demo', 'createHomeServiceTicket', { urgency: 'emergency' }));
    expect(emergency.estimatedArrival).toContain('minutes');
    const routine = parse(handleDemoToolCall('demo', 'createHomeServiceTicket', {}));
    expect(routine.estimatedArrival).toBe('scheduled appointment');
  });

  it('returns four availability slots for checkTechnicianAvailability', () => {
    const res = parse(handleDemoToolCall('demo', 'checkTechnicianAvailability', {}));
    expect(Array.isArray(res.availableSlots)).toBe(true);
    expect((res.availableSlots as unknown[]).length).toBe(4);
  });

  it('produces a valid scripted response for every demo tool', () => {
    const tools = [
      'createServiceTicket',
      'createAfterHoursTicket',
      'triageEscalate',
      'scheduleDentalAppointment',
      'submitMaintenanceRequest',
      'scheduleConsultation',
      'createSupportTicket',
      'lookupFaq',
      'escalateToAgent',
      'lookupAccountStatus',
      'recordPaymentArrangement',
      'recordCollectionOutcome',
      'bookServiceAppointment',
      'checkTechnicianAvailability',
      'createHomeServiceTicket',
      'sendServiceConfirmationSms',
    ];
    for (const tool of tools) {
      const res = parse(handleDemoToolCall('demo', tool, {}));
      expect(res, tool).toMatchObject({ success: true, demo: true });
    }
  });
});
