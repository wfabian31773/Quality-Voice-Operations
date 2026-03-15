import type { AgentToolDef } from '../../types';

export const LEGAL_TOOLS: AgentToolDef[] = [
  {
    name: 'scheduleConsultation',
    description: 'Schedule a legal consultation. Collect caller details, matter description, and opposing party names for conflict check.',
    parameters: {
      type: 'object',
      properties: {
        callerFirstName: { type: 'string', description: "Caller's first name" },
        callerLastName: { type: 'string', description: "Caller's last name" },
        callerPhone: { type: 'string', description: "Caller's phone number" },
        matterDescription: { type: 'string', description: 'Brief description of the legal matter' },
        matterType: { type: 'string', description: 'Type of legal matter (family, criminal, civil, business, etc.)' },
        opposingPartyNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of opposing parties for conflict-of-interest check',
        },
        preferredDate: { type: 'string', description: 'Preferred consultation date' },
        preferredTime: { type: 'string', description: 'Preferred consultation time' },
        additionalNotes: { type: 'string', description: 'Additional notes' },
      },
      required: ['callerFirstName', 'callerLastName', 'callerPhone', 'matterDescription', 'opposingPartyNames'],
    },
  },
];
