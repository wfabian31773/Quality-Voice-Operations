import type { SlotType } from '../types';

export interface SlotDefinition {
  type: SlotType;
  label: string;
  prompt: string;
  required: boolean;
  validation?: (value: string) => boolean;
}

export const BASE_SLOT_DEFINITIONS: Record<SlotType, SlotDefinition> = {
  patient_name: {
    type: 'patient_name',
    label: 'Patient Name',
    prompt: 'May I have your first and last name?',
    required: true,
  },
  patient_dob: {
    type: 'patient_dob',
    label: 'Date of Birth',
    prompt: 'And your date of birth?',
    required: true,
  },
  callback_number: {
    type: 'callback_number',
    label: 'Callback Number',
    prompt: 'What is the best number to reach you?',
    required: true,
  },
  reason_for_call: {
    type: 'reason_for_call',
    label: 'Reason for Call',
    prompt: "What's the reason for your call today?",
    required: true,
  },
  preferred_provider: {
    type: 'preferred_provider',
    label: 'Preferred Provider',
    prompt: 'Do you have a preferred provider?',
    required: false,
  },
  preferred_location: {
    type: 'preferred_location',
    label: 'Preferred Location',
    prompt: 'Which of our locations is most convenient for you?',
    required: false,
  },
  appointment_date: {
    type: 'appointment_date',
    label: 'Preferred Date',
    prompt: 'What date works best for you?',
    required: false,
  },
  appointment_time: {
    type: 'appointment_time',
    label: 'Preferred Time',
    prompt: 'Do you have a preferred time of day — morning or afternoon?',
    required: false,
  },
  urgency_level: {
    type: 'urgency_level',
    label: 'Urgency',
    prompt: 'How would you describe the urgency — routine, soon, or urgent?',
    required: false,
  },
  symptom_description: {
    type: 'symptom_description',
    label: 'Symptom Description',
    prompt: 'Can you describe what you are experiencing?',
    required: false,
  },
};
