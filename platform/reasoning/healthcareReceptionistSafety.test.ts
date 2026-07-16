import { describe, expect, it } from 'vitest';
import { ReasoningEngine } from './ReasoningEngine';
import { SafetyGate } from './SafetyGate';
import type { ReasoningContext } from './types';

function engine() {
  return new ReasoningEngine({
    tenantId: 'tenant-1' as never,
    callSessionId: 'call-1',
    callSid: 'CA-1',
    agentSlug: 'healthcare-receptionist',
    vertical: 'healthcare-receptionist',
    callerNumber: '+15555550100',
    toolsAvailable: ['createServiceTicket', 'lookupSchedule', 'escalate_to_human'],
  });
}

describe('healthcare receptionist reasoning safety', () => {
  it('injects the regulated medical prohibition policy', () => {
    const prompt = engine().getSafetyPolicyPrompt();
    expect(prompt).toContain('Do NOT diagnose');
    expect(prompt).toContain('changing dosages');
    expect(prompt).toContain('medical professional');
  });

  it('blocks prohibited medical advice in generated responses', () => {
    const result = engine().checkResponseSafety('Based on this, you have an infection and should stop taking the medication.');
    expect(result.allowed).toBe(false);
    expect(result.violations.map((violation) => violation.type)).toContain('prohibited_advice');
  });

  it('applies the same SafetyGate medical category as other healthcare roles', () => {
    const context = { vertical: 'healthcare-receptionist', callSessionId: 'call-1' } as ReasoningContext;
    const result = new SafetyGate('healthcare-receptionist').checkResponseSafety('You have a serious condition.', context);
    expect(result.allowed).toBe(false);
  });

  it('authorizes a complete multilingual staff-ready outcome from explicit evidence without English slot extraction', () => {
    const reasoning = engine();
    reasoning.processUtterance('Necesito una cita y mi nombre es Ana López.', 'unknown', 'low');
    const args = {
      callerFirstName: 'Ana',
      callerLastName: 'López',
      callerPhone: '+15555550100',
      callbackNumber: '+15555550100',
      callerType: 'patient',
      reasonForCall: 'Solicita una cita',
      outcomeType: 'appointment_request',
      requestedAction: 'Llamar para confirmar una cita',
      urgency: 'routine',
      callbackPreference: 'por la tarde',
      identityVerificationStatus: 'partially_verified',
      consentToContact: true,
      evidenceSource: ['caller_statement', 'caller_id'],
    };
    expect(reasoning.authorizeToolRequest('createServiceTicket', args)).toMatchObject({ allowed: true });
  });

  it('blocks a healthcare outcome whose structured evidence is incomplete', () => {
    const result = engine().authorizeToolRequest('createServiceTicket', {
      callerFirstName: 'Ana',
      outcomeType: 'appointment_request',
      evidenceSource: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((violation) => violation.type)).toContain('missing_required_data');
  });

  it('allows a professional caller outcome without requiring the professional caller to be a patient', () => {
    const result = engine().authorizeToolRequest('createServiceTicket', {
      callerFirstName: 'Morgan',
      callerLastName: 'Lee',
      callerPhone: '+15555550120',
      callbackNumber: '+15555550120',
      callerType: 'pharmacy',
      organizationName: 'Central Pharmacy',
      reasonForCall: 'Refill clarification requested by the pharmacy',
      outcomeType: 'staff_message',
      requestedAction: 'Pharmacy callback',
      urgency: 'routine',
      callbackPreference: 'business hours',
      identityVerificationStatus: 'not_required',
      consentToContact: true,
      evidenceSource: ['caller_statement'],
    });
    expect(result.allowed).toBe(true);
  });
});
