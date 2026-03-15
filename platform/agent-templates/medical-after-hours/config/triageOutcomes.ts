/**
 * Triage outcome mappings for the Medical After-Hours Agent.
 *
 * Extracted from src/config/afterHoursTicketing.ts.
 * Tenant-overridable: tenants can extend or replace these at registration time.
 */

export type TriageOutcome =
  | 'urgent_transfer'
  | 'callback_next_business_day'
  | 'callback_within_24h'
  | 'emergency_services'
  | 'voicemail';

export interface TriageOutcomeConfig {
  outcome: TriageOutcome;
  label: string;
  requiresHumanTransfer: boolean;
  ticketPriority: 'urgent' | 'high' | 'medium' | 'low';
}

export const DEFAULT_TRIAGE_OUTCOME_MAPPINGS: Record<TriageOutcome, TriageOutcomeConfig> = {
  urgent_transfer: {
    outcome: 'urgent_transfer',
    label: 'Urgent — Transfer to On-Call',
    requiresHumanTransfer: true,
    ticketPriority: 'urgent',
  },
  callback_within_24h: {
    outcome: 'callback_within_24h',
    label: 'Callback Within 24 Hours',
    requiresHumanTransfer: false,
    ticketPriority: 'high',
  },
  callback_next_business_day: {
    outcome: 'callback_next_business_day',
    label: 'Next Business Day Callback',
    requiresHumanTransfer: false,
    ticketPriority: 'medium',
  },
  emergency_services: {
    outcome: 'emergency_services',
    label: 'Directed to 911',
    requiresHumanTransfer: false,
    ticketPriority: 'urgent',
  },
  voicemail: {
    outcome: 'voicemail',
    label: 'Voicemail Left',
    requiresHumanTransfer: false,
    ticketPriority: 'low',
  },
};
