import type { HealthcareOutcomeDashboardProjection } from '../receptionist/healthcareOutcomeDashboard';

export type HealthcareDemoScenarioKind = 'appointment_request' | 'safe_escalation';

export type HealthcareDemoSignal =
  | 'language_change'
  | 'caller_interruption'
  | 'memory_retained'
  | 'current_time'
  | 'tool_confirmed'
  | 'safety_boundary'
  | 'human_escalation';

export interface HealthcareDemoTranscriptLine {
  id: string;
  speaker: 'caller' | 'assistant';
  language: 'en' | 'es';
  text: string;
  signal?: HealthcareDemoSignal;
}

export interface HealthcareDemoTimelineStep {
  id: string;
  label: string;
  detail: string;
  signal: HealthcareDemoSignal;
  status: 'complete';
}

export interface HealthcareDemoResult {
  mode: 'guided_production_workflow';
  disclosure: string;
  scenario: HealthcareDemoScenarioKind;
  runtime: {
    coreVersion: string;
    rolePackageId: 'healthcare-receptionist';
    rolePackageVersion: string;
  };
  transcript: HealthcareDemoTranscriptLine[];
  timeline: HealthcareDemoTimelineStep[];
  tool: {
    name: 'createServiceTicket';
    status: 'success' | 'failed';
    productionContract: true;
    confirmationMessage: string;
  };
  projection: HealthcareOutcomeDashboardProjection;
  claims: string[];
}
