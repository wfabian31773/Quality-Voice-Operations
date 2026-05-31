import { describe, it, expect } from 'vitest';
import { globalToolRegistry } from './registry';
import { registerCoreTools } from './registerCoreTools';
import { registerTemplateTools } from './registerTemplateTools';
import { unifiedToolRegistry } from './ToolRegistry';

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
});
