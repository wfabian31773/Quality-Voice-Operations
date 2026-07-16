// @vitest-environment happy-dom
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

void React;

const analytics = vi.hoisted(() => ({
  pageView: vi.fn(), interaction: vi.fn(), cta: vi.fn(), conversion: vi.fn(), utm: vi.fn(),
}));

vi.mock('../../client-app/src/lib/analytics', () => ({
  trackPageView: analytics.pageView,
  trackDemoInteraction: analytics.interaction,
  trackCTAClick: analytics.cta,
  trackConversionEvent: analytics.conversion,
  captureUtmOnLoad: analytics.utm,
}));
vi.mock('../../client-app/src/components/SEO', () => ({ default: () => null }));

import Demo from '../../client-app/src/pages/Demo';

const baseProjection = {
  callId: 'demo-call-appointment', language: 'es-en', lifecycleState: 'CALL_COMPLETED',
  startedAt: '2026-07-12T17:30:00.000Z', endedAt: '2026-07-12T17:32:00.000Z',
  caller: { firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100', type: 'patient', organizationName: null },
  patient: { firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100' },
  intent: 'Annual eye exam request',
  outcome: {
    type: 'appointment_request', summary: 'appointment request: Annual eye exam request. Staff confirmation required.',
    requestedAction: 'Call back to arrange an appointment time', urgency: 'routine',
    callbackPreference: 'weekday afternoon', identityVerificationStatus: 'partially_verified',
    consentToContact: true, evidenceSource: ['caller_statement', 'caller_id'],
  },
  transcript: { available: true, lineCount: 6 },
  recording: { policy: 'disabled', status: 'not_recorded', url: null },
  delivery: { id: 'demo-outbox-1', status: 'sent', error: null, externalReference: 'DEMO-101' },
  followUp: { ticketId: 'demo-ticket-1', ticketNumber: 101, ownerId: null, ownerLabel: 'Unassigned', priority: 'medium', status: 'open', nextAction: 'Call back to arrange an appointment time' },
  tool: { id: 'demo-tool-1', name: 'createServiceTicket', status: 'success', error: null, invokedAt: '2026-07-12T17:31:00Z', result: { success: true } },
  escalation: null,
  operationalValue: { state: 'staff_follow_up_created', evidence: 'A staff follow-up ticket was created.' },
};

function fixture(scenario: 'appointment_request' | 'safe_escalation') {
  const escalation = scenario === 'safe_escalation';
  return {
    mode: 'guided_production_workflow',
    disclosure: 'Guided workflow using production contracts. This is not a live phone call.',
    scenario,
    runtime: { coreVersion: '1.0.0', rolePackageId: 'healthcare-receptionist', rolePackageVersion: '1.0.0' },
    transcript: escalation ? [
      { id: 's1', speaker: 'caller', language: 'en', text: 'I have severe chest pain. What should I do?', signal: 'safety_boundary' },
      { id: 's2', speaker: 'assistant', language: 'en', text: "I can't diagnose this. If this may be an immediate emergency, call 911 or emergency services now.", signal: 'human_escalation' },
    ] : [
      { id: 'a1', speaker: 'assistant', language: 'es', text: 'Hola, soy la recepcionista virtual de Northstar Clinic.' },
      { id: 'a2', speaker: 'caller', language: 'es', text: 'Necesito una cita para un examen anual.' },
      { id: 'a3', speaker: 'assistant', language: 'es', text: 'Claro. ¿Me puede dar su nombre—', signal: 'caller_interruption' },
      { id: 'a4', speaker: 'caller', language: 'en', text: 'Sorry—English is easier. I am Ana Lopez.', signal: 'language_change' },
      { id: 'a5', speaker: 'assistant', language: 'en', text: 'Of course. Today is Sunday, July 12, 2026. What callback number should staff use?', signal: 'current_time' },
      { id: 'a6', speaker: 'assistant', language: 'en', text: 'I have your number and request. I will not ask for them again.', signal: 'memory_retained' },
    ],
    timeline: [
      { id: 't1', label: 'Spanish detected', detail: 'Responded naturally in Spanish', signal: 'language_change', status: 'complete' },
      { id: 't2', label: 'Caller interrupted', detail: 'Stopped and listened', signal: 'caller_interruption', status: 'complete' },
      { id: 't3', label: 'Tool confirmed', detail: 'createServiceTicket returned success', signal: 'tool_confirmed', status: 'complete' },
    ],
    tool: { name: 'createServiceTicket', status: 'success', productionContract: true, confirmationMessage: 'Request submitted for staff review.' },
    projection: escalation ? {
      ...baseProjection,
      outcome: { ...baseProjection.outcome, type: 'urgent_escalation', summary: 'Urgent concern recorded for human follow-up.', urgency: 'emergency', requestedAction: 'Immediate human review' },
      escalation: { id: 'demo-escalation-1', reason: 'Emergency concern', priority: 'critical', status: 'pending', ownerId: null, ownerLabel: 'Unassigned', toolName: 'createServiceTicket', createdAt: '2026-07-12T17:31:00Z' },
      operationalValue: { state: 'human_follow_up_required', evidence: 'A human follow-up task was created.' },
    } : baseProjection,
    claims: ['Staff follow-up created'],
  };
}

let requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  requests = [];
  Object.values(analytics).forEach((mock) => mock.mockReset());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    requests.push({ url, method, body });
    if (url === '/api/demo/healthcare/run' && method === 'POST') {
      return new Response(JSON.stringify(fixture(body.scenario as 'appointment_request' | 'safe_escalation')), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDemo() {
  return render(<MemoryRouter initialEntries={['/demo']}><Demo /></MemoryRouter>);
}

describe('healthcare-first demo', () => {
  it('replaces the generic agent gallery with one bounded healthcare proof', () => {
    renderDemo();
    expect(screen.getByRole('heading', { level: 1, name: /one call\. one staff-ready outcome/i })).toBeTruthy();
    expect(screen.getByText(/guided workflow/i)).toBeTruthy();
    expect(screen.getByText(/Master Voice Agent 1\.0\.0/i)).toBeTruthy();
    expect(screen.getByText(/Healthcare Receptionist 1\.0\.0/i)).toBeTruthy();
    expect(screen.queryByText(/choose an agent|agent marketplace|deploy your own AI voice agents/i)).toBeNull();
    expect(screen.getByRole('button', { name: /appointment request/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /safe escalation/i })).toBeTruthy();
  });

  it('runs the appointment journey and renders the shared staff-ready outcome without internal links', async () => {
    renderDemo();
    fireEvent.click(screen.getByRole('button', { name: /run appointment workflow/i }));

    await screen.findByRole('heading', { name: /receptionist outcome/i });
    expect(requests.some((request) => request.url === '/api/demo/healthcare/run' && request.body.scenario === 'appointment_request')).toBe(true);
    expect(screen.getByText(/caller interrupted/i)).toBeTruthy();
    expect(screen.getByText(/Spanish → English/i)).toBeTruthy();
    expect(screen.getByText(/Sunday, July 12, 2026/i)).toBeTruthy();
    expect(screen.getByText(/production tool contract confirmed/i)).toBeTruthy();
    expect(screen.getByText(/staff confirmation required/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open follow-up ticket/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/appointment (is |was )?booked|recovered \$|HIPAA compliant/i);
    expect(analytics.conversion).toHaveBeenCalledWith('demo_completed', '/demo', expect.objectContaining({ scenario: 'appointment_request' }));
  });

  it('resets deterministically and runs the safe-escalation branch', async () => {
    renderDemo();
    fireEvent.click(screen.getByRole('button', { name: /run appointment workflow/i }));
    await screen.findByRole('heading', { name: /receptionist outcome/i });
    fireEvent.click(screen.getByRole('button', { name: /reset demo/i }));
    expect(screen.queryByRole('heading', { name: /receptionist outcome/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /safe escalation/i }));
    fireEvent.click(screen.getByRole('button', { name: /run safe escalation/i }));
    await waitFor(() => expect(screen.getByText(/I can't diagnose/i)).toBeTruthy());
    expect(screen.getByText(/911 or emergency services/i)).toBeTruthy();
    expect(screen.getByText(/human follow-up task was created/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/transfer(red)? successfully|transfer completed/i);
  });

  it('surfaces a safe retry state when the scenario endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })));
    renderDemo();
    fireEvent.click(screen.getByRole('button', { name: /run appointment workflow/i }));
    expect(await screen.findByText(/couldn't run the guided workflow/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });
});
