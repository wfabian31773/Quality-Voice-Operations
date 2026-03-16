import type { AgentToolDef } from '../../types';

export const COLLECTIONS_TOOLS: AgentToolDef[] = [
  {
    name: 'lookupAccountStatus',
    description: 'Look up the debtor\'s account status including balance, payment history, and overdue details.',
    parameters: {
      type: 'object',
      properties: {
        debtorFirstName: { type: 'string', description: "Debtor's first name" },
        debtorLastName: { type: 'string', description: "Debtor's last name" },
        debtorPhone: { type: 'string', description: "Debtor's phone number" },
        accountNumber: { type: 'string', description: "Debtor's account number" },
        lastFourSsn: { type: 'string', description: 'Last 4 digits of SSN for verification' },
      },
      required: ['debtorLastName', 'debtorPhone'],
    },
  },
  {
    name: 'recordPaymentArrangement',
    description: 'Record a payment arrangement agreed to by the debtor.',
    parameters: {
      type: 'object',
      properties: {
        debtorFirstName: { type: 'string', description: "Debtor's first name" },
        debtorLastName: { type: 'string', description: "Debtor's last name" },
        debtorPhone: { type: 'string', description: "Debtor's phone number" },
        accountNumber: { type: 'string', description: "Debtor's account number" },
        arrangementType: {
          type: 'string',
          enum: ['full_payment', 'installment_plan', 'hardship_program', 'promise_to_pay'],
          description: 'Type of payment arrangement',
        },
        totalAmount: { type: 'number', description: 'Total amount to be paid' },
        paymentDate: { type: 'string', description: 'Date the payment or first installment is due' },
        installmentAmount: { type: 'number', description: 'Amount per installment (if applicable)' },
        installmentFrequency: {
          type: 'string',
          enum: ['weekly', 'biweekly', 'monthly'],
          description: 'Frequency of installment payments (if applicable)',
        },
        additionalNotes: { type: 'string', description: 'Additional notes about the arrangement' },
      },
      required: ['debtorFirstName', 'debtorLastName', 'debtorPhone', 'arrangementType', 'paymentDate'],
    },
  },
  {
    name: 'recordCollectionOutcome',
    description: 'Record the outcome of the collection call.',
    parameters: {
      type: 'object',
      properties: {
        debtorPhone: { type: 'string', description: "Debtor's phone number" },
        accountNumber: { type: 'string', description: "Debtor's account number" },
        outcome: {
          type: 'string',
          enum: [
            'payment_arranged', 'promise_to_pay', 'dispute_filed',
            'cease_requested', 'attorney_represented', 'no_answer',
            'wrong_number', 'callback_scheduled', 'refused_to_pay',
          ],
          description: 'Outcome of the collection call',
        },
        callbackDate: { type: 'string', description: 'Date for scheduled callback (if applicable)' },
        disputeDetails: { type: 'string', description: 'Details of the dispute (if debt is disputed)' },
        attorneyName: { type: 'string', description: "Debtor's attorney name (if represented)" },
        attorneyPhone: { type: 'string', description: "Debtor's attorney phone (if represented)" },
        notes: { type: 'string', description: 'Summary notes from the call' },
      },
      required: ['debtorPhone', 'outcome'],
    },
  },
];
