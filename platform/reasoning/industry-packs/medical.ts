import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

const MEDICAL_EMERGENCY_KEYWORDS = [
  'chest pain', 'heart attack', "can't breathe", 'difficulty breathing',
  'stroke', 'unconscious', 'not responding', 'severe bleeding',
  'suicidal', 'overdose', 'anaphylaxis', 'allergic reaction',
  'seizure', 'choking', 'severe abdominal pain', 'head injury',
  'loss of consciousness', 'high fever infant',
];

function triageUrgency(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  for (const keyword of MEDICAL_EMERGENCY_KEYWORDS) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        action: 'escalate_to_human' as const,
        urgencyOverride: 'emergency' as const,
        additionalContext: `Medical emergency detected: "${keyword}". Advise caller to call 911 if life-threatening, then page on-call provider immediately.`,
        modifiedConfidence: 'high' as const,
      };
    }
  }

  const urgentSymptoms = [
    'fever', 'vomiting', 'diarrhea', 'rash', 'pain', 'swelling',
    'infection', 'wound', 'cut', 'burn', 'fall', 'injury',
    'medication reaction', 'side effect',
  ];

  for (const symptom of urgentSymptoms) {
    if (utterance.includes(symptom)) {
      return {
        triggered: true,
        urgencyOverride: 'urgent' as const,
        additionalContext: `Medical symptom reported: "${symptom}". Collect detailed triage information and page on-call if after hours.`,
      };
    }
  }

  return { triggered: false };
}

function detectMedicationInquiry(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();
  const medicationKeywords = ['prescription', 'refill', 'medication', 'medicine', 'rx', 'pharmacy', 'dosage', 'side effect'];

  for (const keyword of medicationKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Medication-related inquiry detected. Do NOT provide medical advice. Collect information and relay to provider.',
      };
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'medical_triage_urgency',
    vertical: 'medical-after-hours',
    name: 'Medical Triage Urgency',
    description: 'Triage medical symptoms by urgency level and escalate emergencies',
    evaluate: triageUrgency,
  },
  {
    id: 'medical_medication_inquiry',
    vertical: 'medical-after-hours',
    name: 'Medication Inquiry Detection',
    description: 'Detect medication-related inquiries and enforce no-advice policy',
    evaluate: detectMedicationInquiry,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  urgent_medical: {
    vertical: 'medical-after-hours',
    intent: 'urgent_medical',
    slots: [
      { name: 'caller_name', label: 'Patient Name', required: true, prompt: 'May I have the patient name?' },
      { name: 'patient_dob', label: 'Date of Birth', required: true, prompt: 'What is the date of birth?', sensitive: true },
      { name: 'callback_number', label: 'Callback Number', required: true, prompt: 'What is the best number to reach you?' },
      { name: 'symptom_description', label: 'Symptoms', required: true, prompt: 'Can you describe the symptoms?' },
      { name: 'urgency_level', label: 'Urgency', required: true, prompt: 'How would you rate the urgency — routine, urgent, or emergency?' },
      { name: 'symptom_duration', label: 'Duration', required: false, prompt: 'How long have these symptoms been present?' },
      { name: 'current_medications', label: 'Current Medications', required: false, prompt: 'Are you currently taking any medications?', sensitive: true },
      { name: 'preferred_provider', label: 'Provider', required: false, prompt: 'Do you have a preferred provider?' },
    ],
  },
  prescription_refill: {
    vertical: 'medical-after-hours',
    intent: 'prescription_refill',
    slots: [
      { name: 'caller_name', label: 'Patient Name', required: true, prompt: 'May I have the patient name?' },
      { name: 'patient_dob', label: 'Date of Birth', required: true, prompt: 'What is the date of birth?', sensitive: true },
      { name: 'callback_number', label: 'Callback Number', required: true, prompt: 'Best number to reach you?' },
      { name: 'medication_name', label: 'Medication', required: true, prompt: 'What medication do you need refilled?' },
      { name: 'pharmacy_name', label: 'Pharmacy', required: false, prompt: 'Which pharmacy should we send the refill to?' },
    ],
  },
};

export const medicalPack: IndustryReasoningPack = {
  vertical: 'medical-after-hours',
  displayName: 'Medical After-Hours',
  rules,
  slotManifests,
  escalationKeywords: MEDICAL_EMERGENCY_KEYWORDS,
  prohibitedAdviceCategories: ['diagnosis', 'prescribe', 'treatment_recommendation', 'medication_advice', 'dosage_adjustment'],
};
