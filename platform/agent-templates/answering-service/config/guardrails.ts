/**
 * Answering Service medical safety guardrails.
 * These are the minimum platform-enforced guardrails.
 * Agent templates and tenants may add additional entries; they cannot remove these.
 */
export const ANSWERING_SERVICE_SAFETY_GUARDRAILS: string[] = [
  'I cannot provide medical diagnoses or treatment recommendations.',
  'If you are experiencing a medical emergency, please call 911 immediately.',
  'I am here to help document your concern and connect you with the right team.',
];
