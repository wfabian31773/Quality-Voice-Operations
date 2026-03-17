import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

const DENTAL_EMERGENCY_KEYWORDS = [
  'knocked out tooth', 'avulsed tooth', 'severe swelling',
  'uncontrollable bleeding', 'jaw fracture', 'broken jaw',
  'abscess spreading', 'difficulty swallowing', 'difficulty breathing',
];

function classifyDentalUrgency(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  for (const keyword of DENTAL_EMERGENCY_KEYWORDS) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        action: 'escalate_to_human' as const,
        urgencyOverride: 'emergency' as const,
        additionalContext: `Dental emergency detected: "${keyword}". Immediate contact with on-call dentist required.`,
      };
    }
  }

  const urgentPatterns = ['toothache', 'tooth pain', 'broken tooth', 'chipped tooth', 'lost filling', 'lost crown', 'abscess', 'swollen gums', 'bleeding gums'];
  for (const pattern of urgentPatterns) {
    if (utterance.includes(pattern)) {
      return {
        triggered: true,
        urgencyOverride: 'urgent' as const,
        additionalContext: `Urgent dental issue: "${pattern}". Same-day or next-day appointment recommended.`,
      };
    }
  }

  return { triggered: false };
}

function identifyNewVsExistingPatient(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();
  const newPatientIndicators = ['new patient', 'first time', 'never been', 'looking for a dentist', 'new to the area'];

  for (const indicator of newPatientIndicators) {
    if (utterance.includes(indicator)) {
      return {
        triggered: true,
        additionalContext: 'New patient identified. Collect additional intake information and mention new patient paperwork.',
      };
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'dental_urgency_classification',
    vertical: 'dental',
    name: 'Dental Urgency Classification',
    description: 'Classify dental issues by urgency and type',
    evaluate: classifyDentalUrgency,
  },
  {
    id: 'dental_patient_type',
    vertical: 'dental',
    name: 'New vs Existing Patient',
    description: 'Identify if caller is a new or existing patient',
    evaluate: identifyNewVsExistingPatient,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  schedule_appointment: {
    vertical: 'dental',
    intent: 'schedule_appointment',
    slots: [
      { name: 'caller_name', label: 'Patient Name', required: true, prompt: 'May I have the patient name?' },
      { name: 'patient_dob', label: 'Date of Birth', required: true, prompt: 'What is the date of birth?' },
      { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is the best callback number?' },
      { name: 'reason_for_call', label: 'Reason', required: true, prompt: 'What is the reason for the appointment?' },
      { name: 'insurance_provider', label: 'Insurance', required: false, prompt: 'Do you have dental insurance? If so, which provider?' },
      { name: 'preferred_date', label: 'Preferred Date', required: false, prompt: 'Do you have a preferred date?' },
      { name: 'preferred_time', label: 'Preferred Time', required: false, prompt: 'Morning or afternoon?' },
    ],
  },
};

export const dentalPack: IndustryReasoningPack = {
  vertical: 'dental',
  displayName: 'Dental Office',
  rules,
  slotManifests,
  escalationKeywords: DENTAL_EMERGENCY_KEYWORDS,
  prohibitedAdviceCategories: ['diagnosis', 'treatment_recommendation', 'medication_advice'],
};
