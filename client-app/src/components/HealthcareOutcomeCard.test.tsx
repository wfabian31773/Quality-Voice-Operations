// @vitest-environment happy-dom
import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import HealthcareOutcomeCard from './HealthcareOutcomeCard';
import type { HealthcareOutcomeDashboardProjection } from '../../../shared/receptionist/healthcareOutcomeDashboard';

void React;

afterEach(cleanup);

const projection: HealthcareOutcomeDashboardProjection = {
  callId: 'call-1', language: 'es', lifecycleState: 'CALL_COMPLETED', startedAt: null, endedAt: null,
  caller: { firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100', type: 'patient', organizationName: null },
  patient: { firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100' },
  intent: 'Needs an annual eye exam',
  outcome: {
    type: 'appointment_request', summary: 'Appointment request; staff confirmation required.',
    requestedAction: 'Call back to arrange a time', urgency: 'routine', callbackPreference: 'weekday afternoons',
    identityVerificationStatus: 'partially_verified', consentToContact: true,
    evidenceSource: ['caller_statement'],
  },
  transcript: { available: true, lineCount: 4 },
  recording: { policy: 'disabled', status: 'not_recorded', url: null },
  delivery: { id: 'out-1', status: 'sent', error: null, externalReference: 'EXT-1' },
  followUp: {
    ticketId: 'ticket-1', ticketNumber: 17, ownerId: null, ownerLabel: 'Unassigned',
    priority: 'medium', status: 'open', nextAction: 'Call back to arrange a time',
  },
  tool: { id: 'tool-1', name: 'createServiceTicket', status: 'success', error: null, invokedAt: null, result: null },
  escalation: null,
  operationalValue: { state: 'staff_follow_up_created', evidence: 'A staff follow-up ticket was created.' },
};

describe('HealthcareOutcomeCard', () => {
  it('renders staff-ready evidence without claiming an appointment was booked', () => {
    render(<MemoryRouter><HealthcareOutcomeCard projection={projection} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /receptionist outcome/i })).toBeTruthy();
    expect(screen.getAllByText(/appointment request/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Call back to arrange a time')).toHaveLength(2);
    expect(screen.getByText(/staff confirmation required/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /open follow-up ticket/i }).getAttribute('href')).toBe('/tickets/ticket-1');
    expect(screen.queryByText(/appointment booked/i)).toBeNull();
  });

  it('surfaces delivery, tool, and escalation failure evidence truthfully', () => {
    const failed: HealthcareOutcomeDashboardProjection = {
      ...projection,
      delivery: { id: 'out-1', status: 'dead_letter', error: 'connector unavailable', externalReference: null },
      followUp: { ...projection.followUp!, ticketId: null, ticketNumber: null, status: 'queued' },
      tool: { ...projection.tool!, status: 'failed', error: 'timeout' },
      escalation: {
        id: 'esc-1', reason: 'Tool failed', priority: 'high', status: 'pending', ownerId: null,
        ownerLabel: 'Unassigned', toolName: 'createServiceTicket', createdAt: null,
      },
      operationalValue: { state: 'delivery_attention_required', evidence: 'The request is durable, but external delivery needs staff attention.' },
    };
    render(<MemoryRouter><HealthcareOutcomeCard projection={failed} /></MemoryRouter>);
    expect(screen.getByText(/connector unavailable/i)).toBeTruthy();
    expect(screen.getByText(/timeout/i)).toBeTruthy();
    expect(screen.getByText(/Tool failed/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open follow-up ticket/i })).toBeNull();
  });
});
