import type { AgentToolDef } from '../../types';

export const CUSTOMER_SUPPORT_TOOLS: AgentToolDef[] = [
  {
    name: 'createSupportTicket',
    description: 'Create a customer support ticket. Collect the customer details and issue description before calling this tool.',
    parameters: {
      type: 'object',
      properties: {
        customerFirstName: { type: 'string', description: "Customer's first name" },
        customerLastName: { type: 'string', description: "Customer's last name" },
        customerPhone: { type: 'string', description: "Customer's phone number" },
        customerEmail: { type: 'string', description: "Customer's email address" },
        accountNumber: { type: 'string', description: "Customer's account number (if available)" },
        issueCategory: {
          type: 'string',
          enum: ['billing', 'technical', 'product', 'shipping', 'account', 'general'],
          description: 'Category of the support issue',
        },
        issueDescription: { type: 'string', description: 'Detailed description of the issue' },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Priority level of the issue',
        },
        additionalNotes: { type: 'string', description: 'Any additional notes' },
      },
      required: ['customerFirstName', 'customerLastName', 'customerPhone', 'issueCategory', 'issueDescription'],
    },
  },
  {
    name: 'lookupFaq',
    description: 'Look up an answer from the FAQ knowledge base. Use this when the caller asks a common question.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to look up in the FAQ' },
        category: { type: 'string', description: 'Optional category to narrow the search' },
      },
      required: ['question'],
    },
  },
  {
    name: 'escalateToAgent',
    description: 'Escalate the call to a human agent or supervisor. Use when you cannot resolve the issue or the caller requests a human.',
    parameters: {
      type: 'object',
      properties: {
        customerFirstName: { type: 'string', description: "Customer's first name" },
        customerLastName: { type: 'string', description: "Customer's last name" },
        customerPhone: { type: 'string', description: "Customer's phone number" },
        reason: { type: 'string', description: 'Reason for escalation' },
        escalationType: {
          type: 'string',
          enum: ['supervisor', 'billing_team', 'technical_team', 'retention'],
          description: 'Type of escalation',
        },
        conversationSummary: { type: 'string', description: 'Summary of the conversation so far' },
      },
      required: ['customerFirstName', 'customerPhone', 'reason', 'escalationType'],
    },
  },
];
