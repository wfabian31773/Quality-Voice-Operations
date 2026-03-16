import type { AgentToolDef } from '../../types';

export const TECHNICAL_SUPPORT_TOOLS: AgentToolDef[] = [
  {
    name: 'collectDiagnostics',
    description: 'Record diagnostic information gathered from the caller during troubleshooting.',
    parameters: {
      type: 'object',
      properties: {
        customerFirstName: { type: 'string', description: "Customer's first name" },
        customerLastName: { type: 'string', description: "Customer's last name" },
        customerPhone: { type: 'string', description: "Customer's phone number" },
        accountNumber: { type: 'string', description: "Customer's account number" },
        productName: { type: 'string', description: 'Product or service affected' },
        issueDescription: { type: 'string', description: 'Detailed description of the issue' },
        errorMessages: { type: 'string', description: 'Error messages or codes reported' },
        issueStartTime: { type: 'string', description: 'When the issue started' },
        stepsAttempted: { type: 'string', description: 'Troubleshooting steps already attempted by the caller' },
        environmentDetails: { type: 'string', description: 'OS, browser, device, or other environment details' },
      },
      required: ['customerFirstName', 'customerLastName', 'customerPhone', 'issueDescription'],
    },
  },
  {
    name: 'createTechTicket',
    description: 'Create a technical support ticket for issues that need further investigation or escalation.',
    parameters: {
      type: 'object',
      properties: {
        customerFirstName: { type: 'string', description: "Customer's first name" },
        customerLastName: { type: 'string', description: "Customer's last name" },
        customerPhone: { type: 'string', description: "Customer's phone number" },
        accountNumber: { type: 'string', description: "Customer's account number" },
        issueDescription: { type: 'string', description: 'Detailed description of the issue' },
        diagnosticsSummary: { type: 'string', description: 'Summary of diagnostic data collected' },
        stepsAttempted: { type: 'string', description: 'Troubleshooting steps already attempted' },
        severity: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Severity level of the issue',
        },
        escalationTier: {
          type: 'string',
          enum: ['tier_2', 'tier_3'],
          description: 'Which support tier to escalate to',
        },
        additionalNotes: { type: 'string', description: 'Additional notes' },
      },
      required: ['customerFirstName', 'customerLastName', 'customerPhone', 'issueDescription', 'severity', 'escalationTier'],
    },
  },
  {
    name: 'lookupKnowledgeBase',
    description: 'Search the technical knowledge base for known issues and solutions.',
    parameters: {
      type: 'object',
      properties: {
        searchQuery: { type: 'string', description: 'Search query describing the issue' },
        productName: { type: 'string', description: 'Product name to filter results' },
        errorCode: { type: 'string', description: 'Error code to search for' },
      },
      required: ['searchQuery'],
    },
  },
];
