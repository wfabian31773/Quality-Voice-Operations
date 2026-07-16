import { describe, expect, it } from 'vitest';
import { buildHealthcareOutcomeDashboardProjection } from './healthcareOutcomeDashboard';

describe('buildHealthcareOutcomeDashboardProjection', () => {
  const call = {
    id: 'call-1',
    language: 'es',
    lifecycle_state: 'CALL_COMPLETED',
    start_time: '2026-07-12T10:00:00.000Z',
    end_time: '2026-07-12T10:03:00.000Z',
    context: { recordingPolicy: { policy: 'disabled', status: 'not_recorded' } },
    transcript_count: 4,
  };

  const outbox = {
    id: 'out-1',
    status: 'sent',
    last_error: null,
    payload: {
      type: 'answering_service_ticket',
      callerFirstName: 'Ana',
      callerLastName: 'Lopez',
      callerPhone: '+15555550100',
      patientFirstName: 'Ana',
      patientLastName: 'Lopez',
      outcomeType: 'appointment_request',
      reasonForCall: 'Needs an annual eye exam',
      summary: 'Appointment request for an annual eye exam; staff confirmation required.',
      requestedAction: 'Call back to arrange an annual eye exam',
      urgency: 'routine',
      callbackPreference: 'weekday afternoons',
      identityVerificationStatus: 'partially_verified',
      consentToContact: true,
      evidenceSource: ['caller_statement', 'caller_id'],
      callerType: 'patient',
    },
    context: { ticketNumber: 'EXT-10' },
  };

  it('projects durable request, ticket, tool, recording, and value evidence without claiming a booking', () => {
    const projection = buildHealthcareOutcomeDashboardProjection({
      call,
      outbox,
      ticket: {
        id: 'ticket-1', ticket_number: 17, status: 'open', priority: 'medium',
        assignee_user_id: null, assignee_email: null, subject: 'Appointment request',
      },
      tool: {
        id: 'tool-1', tool_name: 'createServiceTicket', status: 'success',
        error_message: null, result: { success: true, outboxId: 'out-1' },
        invoked_at: '2026-07-12T10:02:00.000Z',
      },
      escalation: null,
    });

    expect(projection).toMatchObject({
      callId: 'call-1', language: 'es',
      caller: { firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100', type: 'patient' },
      outcome: {
        type: 'appointment_request',
        requestedAction: 'Call back to arrange an annual eye exam',
        summary: 'Appointment request for an annual eye exam; staff confirmation required.',
      },
      transcript: { available: true, lineCount: 4 },
      recording: { policy: 'disabled', status: 'not_recorded', url: null },
      delivery: { id: 'out-1', status: 'sent', error: null },
      followUp: { ticketId: 'ticket-1', ownerLabel: 'Unassigned', status: 'open' },
      tool: { name: 'createServiceTicket', status: 'success' },
      operationalValue: { state: 'staff_follow_up_created', evidence: 'A staff follow-up ticket was created.' },
    });
    expect(JSON.stringify(projection)).not.toMatch(/booked|recovered revenue|\$/i);
  });

  it('shows durable queue and delivery failure truth when the optional ticket projection is absent', () => {
    const projection = buildHealthcareOutcomeDashboardProjection({
      call,
      outbox: { ...outbox, status: 'dead_letter', last_error: 'connector unavailable' },
      ticket: null,
      tool: { id: 'tool-2', tool_name: 'createServiceTicket', status: 'failed', error_message: 'timeout', result: null, invoked_at: '2026-07-12T10:02:00.000Z' },
      escalation: {
        id: 'esc-1', status: 'pending', priority: 'high', reason: 'Tool failed',
        assigned_to: null, tool_name: 'createServiceTicket', metadata: {},
        created_at: '2026-07-12T10:02:05.000Z',
      },
    });

    expect(projection.delivery).toMatchObject({ status: 'dead_letter', error: 'connector unavailable' });
    expect(projection.followUp).toMatchObject({ ticketId: null, status: 'queued' });
    expect(projection.tool).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(projection.escalation).toMatchObject({ id: 'esc-1', status: 'pending', ownerLabel: 'Unassigned' });
    expect(projection.operationalValue).toEqual({
      state: 'delivery_attention_required',
      evidence: 'The request is durable, but external delivery needs staff attention.',
    });
  });

  it('returns a truthful empty projection when no structured outcome exists', () => {
    const projection = buildHealthcareOutcomeDashboardProjection({ call, outbox: null, ticket: null, tool: null, escalation: null });
    expect(projection.outcome).toBeNull();
    expect(projection.operationalValue).toEqual({ state: 'none', evidence: 'No staff-ready outcome has been recorded.' });
  });
});
