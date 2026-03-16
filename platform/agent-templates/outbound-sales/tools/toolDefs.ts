import type { AgentToolDef } from '../../types';

export const OUTBOUND_SALES_TOOLS: AgentToolDef[] = [
  {
    name: 'qualifyLead',
    description: 'Record lead qualification details after gathering information from the prospect.',
    parameters: {
      type: 'object',
      properties: {
        prospectFirstName: { type: 'string', description: "Prospect's first name" },
        prospectLastName: { type: 'string', description: "Prospect's last name" },
        prospectPhone: { type: 'string', description: "Prospect's phone number" },
        prospectEmail: { type: 'string', description: "Prospect's email address" },
        companyName: { type: 'string', description: "Prospect's company name (if B2B)" },
        painPoints: { type: 'string', description: 'Key pain points or needs identified' },
        currentSolution: { type: 'string', description: 'Current solution the prospect is using' },
        isDecisionMaker: { type: 'boolean', description: 'Whether the prospect is the decision maker' },
        leadScore: {
          type: 'string',
          enum: ['hot', 'warm', 'cold'],
          description: 'Lead qualification score',
        },
        additionalNotes: { type: 'string', description: 'Additional notes from the conversation' },
      },
      required: ['prospectFirstName', 'prospectLastName', 'prospectPhone', 'leadScore'],
    },
  },
  {
    name: 'bookAppointment',
    description: 'Book a follow-up appointment or demo for a qualified lead.',
    parameters: {
      type: 'object',
      properties: {
        prospectFirstName: { type: 'string', description: "Prospect's first name" },
        prospectLastName: { type: 'string', description: "Prospect's last name" },
        prospectPhone: { type: 'string', description: "Prospect's phone number" },
        prospectEmail: { type: 'string', description: "Prospect's email address" },
        appointmentType: {
          type: 'string',
          enum: ['demo', 'consultation', 'follow_up_call', 'in_person_meeting'],
          description: 'Type of appointment',
        },
        preferredDate: { type: 'string', description: 'Preferred date for the appointment' },
        preferredTime: { type: 'string', description: 'Preferred time for the appointment' },
        additionalNotes: { type: 'string', description: 'Additional notes' },
      },
      required: ['prospectFirstName', 'prospectLastName', 'prospectPhone', 'appointmentType'],
    },
  },
  {
    name: 'recordCallOutcome',
    description: 'Record the outcome of the sales call in the CRM.',
    parameters: {
      type: 'object',
      properties: {
        prospectPhone: { type: 'string', description: "Prospect's phone number" },
        outcome: {
          type: 'string',
          enum: ['appointment_booked', 'callback_scheduled', 'not_interested', 'do_not_call', 'no_answer', 'voicemail', 'wrong_number'],
          description: 'Outcome of the call',
        },
        callbackDate: { type: 'string', description: 'Date for scheduled callback (if applicable)' },
        callbackTime: { type: 'string', description: 'Time for scheduled callback (if applicable)' },
        notes: { type: 'string', description: 'Summary notes from the call' },
      },
      required: ['prospectPhone', 'outcome'],
    },
  },
];
