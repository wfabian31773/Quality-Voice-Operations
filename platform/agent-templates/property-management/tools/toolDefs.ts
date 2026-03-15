import type { AgentToolDef } from '../../types';

export const PROPERTY_MANAGEMENT_TOOLS: AgentToolDef[] = [
  {
    name: 'submitMaintenanceRequest',
    description: 'Submit a maintenance request for a rental unit. Collect tenant details, unit address, issue description, and urgency.',
    parameters: {
      type: 'object',
      properties: {
        tenantName: { type: 'string', description: 'Name of the tenant reporting the issue' },
        unitAddress: { type: 'string', description: 'Unit or property address' },
        issueDescription: { type: 'string', description: 'Description of the maintenance issue' },
        urgency: { type: 'string', enum: ['low', 'medium', 'high', 'emergency'], description: 'Urgency level' },
        contactPhone: { type: 'string', description: 'Best phone number to reach the tenant' },
        preferredAccessTime: { type: 'string', description: 'Preferred time for maintenance access' },
        additionalNotes: { type: 'string', description: 'Additional notes' },
      },
      required: ['tenantName', 'unitAddress', 'issueDescription', 'urgency', 'contactPhone'],
    },
  },
];
