import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('DEMO_TOOL_HANDLER');

const DEMO_TENANT_ID = 'demo';

const DEMO_TOOL_RESPONSES: Record<string, (args: Record<string, unknown>) => unknown> = {
  createServiceTicket: (args) => ({
    success: true,
    ticketId: `DEMO-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo ticket created for ${(args.callerName as string) || 'caller'}. Priority: ${(args.priority as string) || 'normal'}. A team member would be notified in a real scenario.`,
    department: (args.department as string) || 'general',
    priority: (args.priority as string) || 'normal',
    demo: true,
  }),

  createAfterHoursTicket: (args) => ({
    success: true,
    ticketId: `DEMO-AH-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo after-hours ticket created for ${(args.patientName as string) || 'patient'}. Urgency: ${(args.urgency as string) || 'routine'}. An on-call provider would be paged in a real scenario.`,
    urgency: (args.urgency as string) || 'routine',
    demo: true,
  }),

  triageEscalate: (args) => ({
    success: true,
    escalationId: `DEMO-ESC-${Math.floor(100 + Math.random() * 900)}`,
    outcome: 'demo_escalation',
    message: `Demo escalation processed. Urgency: ${(args.urgency as string) || 'routine'}. In a real scenario, the on-call provider would be contacted immediately.`,
    transferred: false,
    demo: true,
  }),

  scheduleDentalAppointment: (args) => ({
    success: true,
    appointmentId: `DEMO-DA-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo appointment scheduled for ${(args.patientName as string) || 'patient'} on ${(args.preferredDate as string) || 'next available date'} at ${(args.preferredTime as string) || '10:00 AM'}. Reason: ${(args.reason as string) || 'checkup'}.`,
    appointmentDate: (args.preferredDate as string) || '2026-03-20',
    appointmentTime: (args.preferredTime as string) || '10:00 AM',
    demo: true,
  }),

  submitMaintenanceRequest: (args) => ({
    success: true,
    requestId: `DEMO-MR-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo maintenance request submitted. Issue: ${(args.description as string) || 'general inquiry'}. A property manager would be notified in a real scenario.`,
    priority: (args.priority as string) || 'normal',
    estimatedResponse: '24-48 hours',
    demo: true,
  }),

  scheduleConsultation: (args) => ({
    success: true,
    consultationId: `DEMO-LC-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo consultation scheduled for ${(args.clientName as string) || 'client'}. Practice area: ${(args.practiceArea as string) || 'general'}. An attorney would follow up in a real scenario.`,
    scheduledDate: (args.preferredDate as string) || '2026-03-22',
    scheduledTime: (args.preferredTime as string) || '3:00 PM',
    disclaimer: 'This is a demonstration only. No legal advice is being provided.',
    demo: true,
  }),

  createSupportTicket: (args) => ({
    success: true,
    ticketId: `DEMO-CS-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo support ticket created. Category: ${(args.category as string) || 'general'}. Issue: ${(args.description as string) || 'inquiry'}. A support agent would follow up in a real scenario.`,
    category: (args.category as string) || 'general',
    estimatedResponse: '1-2 business hours',
    demo: true,
  }),

  lookupFaq: (args) => ({
    success: true,
    found: true,
    question: (args.query as string) || 'general inquiry',
    answer: 'This is a demo FAQ response. In a real scenario, the system would search the knowledge base for relevant answers to the customer\'s question.',
    confidence: 0.92,
    demo: true,
  }),

  escalateToAgent: (args) => ({
    success: true,
    escalationId: `DEMO-ESC-${Math.floor(1000 + Math.random() * 9000)}`,
    message: `Demo escalation to ${(args.department as string) || 'supervisor'} initiated. Reason: ${(args.reason as string) || 'customer request'}. In a real scenario, the caller would be transferred to a live agent.`,
    estimatedWait: '2-3 minutes',
    demo: true,
  }),

  lookupAccountStatus: (args) => ({
    success: true,
    accountFound: true,
    accountEnding: (args.accountLast4 as string) || '3891',
    outstandingBalance: 1247.50,
    originalCreditor: 'Demo Services Inc.',
    accountStatus: 'active',
    lastPaymentDate: '2025-12-15',
    paymentPlanAvailable: true,
    message: 'This is a demo account lookup. No real financial data is being accessed.',
    demo: true,
  }),

  recordPaymentArrangement: (args) => ({
    success: true,
    arrangementId: `DEMO-PA-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo payment arrangement recorded for ${(args.debtorFirstName as string) || 'debtor'} ${(args.debtorLastName as string) || ''}. Amount: $${(args.amount as string) || '415.83'}/month for ${(args.installments as string) || '3'} months.`,
    monthlyAmount: (args.amount as number) || 415.83,
    installments: (args.installments as number) || 3,
    demo: true,
  }),

  recordCollectionOutcome: (args) => ({
    success: true,
    outcomeId: `DEMO-CO-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo collection outcome recorded. Disposition: ${(args.disposition as string) || 'contact_made'}. Next action scheduled.`,
    disposition: (args.disposition as string) || 'contact_made',
    demo: true,
  }),

  bookServiceAppointment: (args) => ({
    success: true,
    bookingId: `DEMO-SVC-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo service appointment booked for ${(args.customerFirstName as string) || 'customer'} ${(args.customerLastName as string) || ''}. Service: ${(args.serviceType as string) || 'HVAC repair'}. Address: ${(args.serviceAddress as string) || 'provided'}. A technician would be dispatched in a real scenario.`,
    serviceType: (args.serviceType as string) || 'HVAC repair',
    urgency: (args.urgency as string) || 'routine',
    appointmentDate: (args.preferredDate as string) || '2026-03-20',
    appointmentWindow: (args.preferredTimeWindow as string) || '8:00 AM - 12:00 PM',
    technicianAssigned: 'Mike R. — Senior HVAC Technician',
    demo: true,
  }),

  checkTechnicianAvailability: (args) => ({
    success: true,
    availableSlots: [
      { date: (args.preferredDate as string) || '2026-03-20', window: '8:00 AM - 12:00 PM', technician: 'Mike R.' },
      { date: (args.preferredDate as string) || '2026-03-20', window: '1:00 PM - 5:00 PM', technician: 'Sarah T.' },
      { date: '2026-03-21', window: '8:00 AM - 12:00 PM', technician: 'Mike R.' },
      { date: '2026-03-21', window: '1:00 PM - 5:00 PM', technician: 'James K.' },
    ],
    serviceType: (args.serviceType as string) || 'HVAC',
    message: 'Demo technician availability retrieved. In a real scenario, this would check the live dispatch calendar.',
    demo: true,
  }),

  createHomeServiceTicket: (args) => ({
    success: true,
    ticketId: `DEMO-HST-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo service ticket created for ${(args.customerName as string) || 'customer'}. Issue: ${(args.issueDescription as string) || 'service request'}. Priority: ${(args.urgency as string) || 'routine'}. A dispatcher would be notified in a real scenario.`,
    urgency: (args.urgency as string) || 'routine',
    serviceType: (args.serviceType as string) || 'HVAC',
    estimatedArrival: (args.urgency as string) === 'emergency' ? '30-60 minutes' : 'scheduled appointment',
    demo: true,
  }),

  sendServiceConfirmationSms: (args) => ({
    success: true,
    messageId: `DEMO-SMS-${Math.floor(1000 + Math.random() * 9000)}`,
    confirmationMessage: `Demo SMS confirmation would be sent to ${(args.phoneNumber as string) || 'customer phone'}. Booking ID: ${(args.bookingId as string) || 'N/A'}.`,
    recipient: (args.phoneNumber as string) || 'customer',
    message: 'Your service appointment has been confirmed. A technician will arrive during your scheduled window.',
    demo: true,
  }),
};

export function isDemoTenant(tenantId: string): boolean {
  return tenantId === DEMO_TENANT_ID;
}

export function handleDemoToolCall(
  tenantId: string,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (tenantId !== DEMO_TENANT_ID) {
    return null;
  }

  const handler = DEMO_TOOL_RESPONSES[toolName];
  if (handler) {
    logger.info('Demo tool call intercepted — returning synthetic response', {
      tenantId,
      tool: toolName,
    });
    return JSON.stringify(handler(args));
  }

  logger.info('Demo tool call intercepted — no handler, returning generic demo response', {
    tenantId,
    tool: toolName,
  });
  return JSON.stringify({
    success: true,
    message: `Demo mode: ${toolName} executed successfully (simulated).`,
    demo: true,
  });
}
