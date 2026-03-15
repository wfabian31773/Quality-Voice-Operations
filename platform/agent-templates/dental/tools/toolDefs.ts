import type { AgentToolDef } from '../../types';

export const DENTAL_TOOLS: AgentToolDef[] = [
  {
    name: 'scheduleDentalAppointment',
    description: 'Schedule a dental appointment. Collect patient details, preferred date/time, and reason for visit.',
    parameters: {
      type: 'object',
      properties: {
        patientFirstName: { type: 'string', description: "Patient's first name" },
        patientLastName: { type: 'string', description: "Patient's last name" },
        patientPhone: { type: 'string', description: "Patient's phone number" },
        isNewPatient: { type: 'boolean', description: 'Whether the patient is new to the practice' },
        preferredDate: { type: 'string', description: 'Preferred appointment date' },
        preferredTime: { type: 'string', description: 'Preferred appointment time' },
        reasonForVisit: { type: 'string', description: 'Reason for the dental visit' },
        insuranceProvider: { type: 'string', description: 'Insurance provider name (if applicable)' },
        additionalNotes: { type: 'string', description: 'Any additional notes' },
      },
      required: ['patientFirstName', 'patientLastName', 'patientPhone', 'isNewPatient', 'reasonForVisit'],
    },
  },
];
