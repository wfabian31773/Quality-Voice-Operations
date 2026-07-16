import { describe, expect, it } from 'vitest';
import { MASTER_VOICE_AGENT_CORE_VERSION } from '../agent-runtime/masterVoiceAgent';
import { HEALTHCARE_RECEPTIONIST_ROLE_VERSION } from '../agent-templates/healthcare-receptionist/rolePackage';
import {
  auditHealthcareDemoClaims,
  executeHealthcareDemoScenario,
} from './healthcareDemoScenario';

const NOW = new Date('2026-07-12T17:30:00.000Z');

describe('executeHealthcareDemoScenario', () => {
  it('uses the locked core, healthcare role, production ticket contract, and WP4 projection', async () => {
    const result = await executeHealthcareDemoScenario('appointment_request', { now: NOW });

    expect(result.runtime).toEqual({
      coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
      rolePackageId: 'healthcare-receptionist',
      rolePackageVersion: HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
    });
    expect(result.mode).toBe('guided_production_workflow');
    expect(result.tool).toMatchObject({ name: 'createServiceTicket', status: 'success', productionContract: true });
    expect(result.projection).toMatchObject({
      language: 'es-en',
      outcome: { type: 'appointment_request', requestedAction: expect.stringMatching(/call back/i) },
      followUp: { status: 'open', ownerLabel: 'Unassigned' },
      operationalValue: { state: 'staff_follow_up_created' },
    });
    expect(result.projection.outcome?.summary).toMatch(/staff confirmation required/i);
    expect(result.projection.outcome?.summary).not.toMatch(/appointment (is |was )?booked/i);
  });

  it('shows code-switching, interruption recovery, memory continuity, and injected current time', async () => {
    const result = await executeHealthcareDemoScenario('appointment_request', { now: NOW });
    expect(new Set(result.transcript.map((line) => line.language))).toEqual(new Set(['es', 'en']));
    expect(result.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: 'language_change' }),
      expect.objectContaining({ signal: 'caller_interruption' }),
      expect.objectContaining({ signal: 'memory_retained' }),
      expect.objectContaining({ signal: 'current_time' }),
    ]));
    expect(result.transcript.some((line) => /Sunday, July 12, 2026/i.test(line.text))).toBe(true);
    expect(result.transcript.filter((line) => /callback number/i.test(line.text))).toHaveLength(1);
  });

  it('demonstrates the clinical safety boundary and human follow-up without a false transfer claim', async () => {
    const result = await executeHealthcareDemoScenario('safe_escalation', { now: NOW });
    expect(result.transcript.some((line) => /can't diagnose|cannot diagnose/i.test(line.text))).toBe(true);
    expect(result.transcript.some((line) => /911|emergency services/i.test(line.text))).toBe(true);
    expect(result.projection).toMatchObject({
      outcome: { type: 'urgent_escalation' },
      escalation: { status: 'pending', ownerLabel: 'Unassigned' },
      operationalValue: { state: 'human_follow_up_required' },
    });
    expect(JSON.stringify(result)).not.toMatch(/transfer(red)? successfully|transfer completed/i);
  });

  it('is deterministic and resettable for a fixed scenario and clock', async () => {
    const first = await executeHealthcareDemoScenario('appointment_request', { now: NOW });
    const replay = await executeHealthcareDemoScenario('appointment_request', { now: NOW });
    expect(replay).toEqual(first);
  });

  it('rejects unknown scenarios', async () => {
    await expect(executeHealthcareDemoScenario('generic_sales_agent' as never, { now: NOW })).rejects.toThrow(/scenario/i);
  });
});

describe('auditHealthcareDemoClaims', () => {
  it('passes both approved scenario results', async () => {
    for (const scenario of ['appointment_request', 'safe_escalation'] as const) {
      expect(auditHealthcareDemoClaims(await executeHealthcareDemoScenario(scenario, { now: NOW }))).toEqual({ valid: true, violations: [] });
    }
  });

  it.each([
    'Your appointment is booked.',
    'We recovered $1,200 in revenue.',
    'This workflow is HIPAA compliant.',
    'The transfer completed successfully.',
    'This is a live call.',
    'I diagnose this as an infection.',
  ])('rejects prohibited claim: %s', (claim) => {
    const audit = auditHealthcareDemoClaims({ claim });
    expect(audit.valid).toBe(false);
    expect(audit.violations.length).toBeGreaterThan(0);
  });
});
