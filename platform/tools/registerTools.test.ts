import { describe, it, expect } from 'vitest';
import { globalToolRegistry } from './registry';
import { registerCoreTools } from './registerCoreTools';
import { registerTemplateTools } from './registerTemplateTools';
import { unifiedToolRegistry } from './ToolRegistry';
import { createHealthcareReceptionistRolePackage } from '../agent-templates/healthcare-receptionist';

describe('registerCoreTools', () => {
  it('registers the four core tools in the global registry', () => {
    registerCoreTools();
    for (const name of ['lookup_customer', 'update_crm_record', 'record_call_outcome', 'create_campaign']) {
      expect(globalToolRegistry.get(name)?.name).toBe(name);
    }
  });
});

describe('registerTemplateTools', () => {
  it('registers template tools as enhanced definitions with categories', () => {
    registerTemplateTools();
    const ticket = unifiedToolRegistry.getEnhanced('createServiceTicket');
    expect(ticket?.category).toBe('answering-service');
    expect(ticket?.recoveryInstructions).toBeTruthy();
    expect(unifiedToolRegistry.getEnhanced('scheduleDentalAppointment')?.category).toBe('dental');
    expect(unifiedToolRegistry.getEnhanced('triageEscalate')).toBeDefined();
  });

  it('validates createServiceTicket against the active healthcare role schema instead of the legacy global schema', () => {
    registerTemplateTools();
    const role = createHealthcareReceptionistRolePackage({ practiceName: 'Northstar Clinic' });
    const roleSchema = role.tools.find((tool) => tool.name === 'createServiceTicket')?.parameters;
    const args = {
      callerFirstName: 'Morgan', callerLastName: 'Lee', callerPhone: '+15555550120',
      callbackNumber: '+15555550120', callerType: 'pharmacy', organizationName: 'Central Pharmacy',
      reasonForCall: 'Refill clarification', outcomeType: 'staff_message',
      requestedAction: 'Pharmacy callback', urgency: 'routine', callbackPreference: 'business hours',
      identityVerificationStatus: 'not_required', consentToContact: true,
      evidenceSource: ['caller_statement'],
    };

    expect(unifiedToolRegistry.validateToolInput('createServiceTicket', args, roleSchema)).toEqual({
      valid: true,
      errors: [],
    });
    expect(unifiedToolRegistry.validateToolInput('createServiceTicket', {}, roleSchema).valid).toBe(false);
  });
});
