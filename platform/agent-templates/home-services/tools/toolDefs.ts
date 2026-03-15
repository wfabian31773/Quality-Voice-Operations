import type { AgentToolDef } from '../../types';

export const HOME_SERVICES_TOOLS: AgentToolDef[] = [
  {
    name: 'bookServiceAppointment',
    description: 'Book a home service appointment. Collect customer details, service address, issue description, and urgency.',
    parameters: {
      type: 'object',
      properties: {
        customerFirstName: { type: 'string', description: "Customer's first name" },
        customerLastName: { type: 'string', description: "Customer's last name" },
        customerPhone: { type: 'string', description: "Customer's phone number" },
        serviceAddress: { type: 'string', description: 'Address where service is needed' },
        serviceType: { type: 'string', description: 'Type of service (HVAC, plumbing, electrical, etc.)' },
        issueDescription: { type: 'string', description: 'Description of the issue' },
        urgency: { type: 'string', enum: ['routine', 'urgent', 'emergency'], description: 'Urgency level' },
        preferredDate: { type: 'string', description: 'Preferred service date' },
        preferredTimeWindow: { type: 'string', description: 'Preferred time window (morning, afternoon, etc.)' },
        additionalNotes: { type: 'string', description: 'Additional notes' },
      },
      required: ['customerFirstName', 'customerLastName', 'customerPhone', 'serviceAddress', 'serviceType', 'issueDescription', 'urgency'],
    },
  },
];
