import { describe, expect, it } from 'vitest';
import {
  HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS,
  evaluateHealthcareRolePackageScenarios,
  validateHealthcareScenarioCoverage,
} from './scriptedScenarios';
import { createHealthcareReceptionistRolePackage } from './rolePackage';

describe('healthcare receptionist scripted-call contract', () => {
  it('covers every GTM receptionist workflow and failure path', () => {
    const result = validateHealthcareScenarioCoverage(HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS);
    expect(result).toEqual({ valid: true, missingIntents: [], missingLanguages: [] });
  });

  it('requires staff-ready data only when an outcome or escalation is created', () => {
    for (const scenario of HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS) {
      expect(scenario.prohibitedClaims.length).toBeGreaterThan(0);
      if (scenario.expectedAction === 'create_outcome') {
        expect(scenario.requiredOutcomeFields).toEqual(expect.arrayContaining([
          'callerFirstName', 'callerLastName', 'callerPhone', 'callbackNumber',
          'reasonForCall', 'requestedAction', 'urgency', 'evidenceSource',
        ]));
      }
      if (scenario.expectedAction === 'answer_operational_fact' || scenario.expectedAction === 'emergency_instruction') {
        expect(scenario.requiredOutcomeFields).toEqual([]);
      }
    }
  });

  it('keeps every scripted staff-ready field aligned with the active outcome tool contract', () => {
    const role = createHealthcareReceptionistRolePackage({ practiceName: 'Northstar Clinic' });
    const outcomeTool = role.tools.find((tool) => tool.name === 'createServiceTicket');
    const schemaRequired = new Set((outcomeTool?.parameters.required ?? []) as string[]);
    for (const scenario of HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS) {
      if (scenario.expectedAction !== 'create_outcome') continue;
      expect(scenario.requiredOutcomeFields.every((field) => schemaRequired.has(field))).toBe(true);
    }
  });

  it('uses the same role package across English, Spanish, French, German, Portuguese, Chinese, and code-switch calls', () => {
    const multilingual = HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS.filter((scenario) => scenario.languages.length > 0);
    expect(new Set(multilingual.flatMap((scenario) => scenario.languages))).toEqual(
      new Set(['en', 'es', 'fr', 'de', 'pt', 'zh']),
    );
    expect(multilingual.some((scenario) => scenario.languages.length > 1)).toBe(true);
    expect(new Set(multilingual.map((scenario) => scenario.rolePackageId))).toEqual(new Set(['healthcare-receptionist']));
  });

  it('rejects an incomplete scenario suite', () => {
    const result = validateHealthcareScenarioCoverage(HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS.slice(0, 1));
    expect(result.valid).toBe(false);
    expect(result.missingIntents.length + result.missingLanguages.length).toBeGreaterThan(0);
  });

  it('passes every scripted scenario against the compiled role and core contract', () => {
    const role = createHealthcareReceptionistRolePackage({ practiceName: 'Northstar Clinic' });
    const result = evaluateHealthcareRolePackageScenarios(role, HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS.length);
    expect(result.results.every((scenario) => scenario.passed)).toBe(true);
  });

  it('reports exact contract failures for a degraded role package', () => {
    const role = createHealthcareReceptionistRolePackage({ practiceName: 'Northstar Clinic' });
    const degraded = { ...role, rolePackageId: 'wrong-role', rolePrompt: '', systemPrompt: '', tools: [] };
    const result = evaluateHealthcareRolePackageScenarios(degraded, HEALTHCARE_RECEPTIONIST_SCRIPTED_SCENARIOS);
    expect(result.passed).toBe(false);
    expect(Array.from(new Set(result.results.flatMap((scenario) => scenario.failures)))).toEqual(expect.arrayContaining([
      'wrong_role_package', 'missing_multilingual_core', 'missing_staff_ready_contract',
      'missing_appointment_truthfulness', 'missing_emergency_instruction', 'missing_human_escalation',
      'missing_clinical_boundary', 'missing_knowledge_boundary', 'missing_b2b_policy',
      'missing_tool_failure_fallback', 'missing_missed_call_recovery',
    ]));
  });
});
