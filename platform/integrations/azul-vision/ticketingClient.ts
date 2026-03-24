import { createLogger } from '../../core/logger';

const logger = createLogger('AZUL_TICKETING');

export interface TicketSubmission {
  patientFirstName: string;
  patientLastName: string;
  patientDob?: string;
  patientPhone?: string;
  callbackNumber?: string;
  reasonForCall?: string;
  symptomDescription?: string;
  departmentId?: number;
  priority?: string;
  triageOutcome?: string;
  additionalNotes?: string;
  ticketType: 'answering_service' | 'after_hours';
  idempotencyKey?: string;
}

export interface TicketResult {
  success: boolean;
  ticketId?: string;
  error?: string;
}

function getConfig(): { url: string; apiKey: string } | null {
  const url = process.env.TICKETING_SYSTEM_URL;
  const apiKey = process.env.TICKETING_API_KEY;
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ''), apiKey };
}

export async function submitTicket(submission: TicketSubmission): Promise<TicketResult> {
  const config = getConfig();
  if (!config) {
    logger.warn('Ticketing not configured — TICKETING_SYSTEM_URL or TICKETING_API_KEY missing');
    return { success: false, error: 'Ticketing system not configured' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(`${config.url}/api/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        ...(submission.idempotencyKey ? { 'Idempotency-Key': submission.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        patient_first_name: submission.patientFirstName,
        patient_last_name: submission.patientLastName,
        patient_dob: submission.patientDob,
        patient_phone: submission.patientPhone,
        callback_number: submission.callbackNumber,
        reason_for_call: submission.reasonForCall,
        symptom_description: submission.symptomDescription,
        department_id: submission.departmentId,
        priority: submission.priority,
        triage_outcome: submission.triageOutcome,
        additional_notes: submission.additionalNotes,
        ticket_type: submission.ticketType,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      logger.error('Ticketing API error', { status: response.status, error: errorText.substring(0, 200) });
      return { success: false, error: `HTTP ${response.status}` };
    }

    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    logger.info('Ticket submitted to Azul Vision', { ticketId: body.id ?? body.ticket_id });
    return { success: true, ticketId: (body.id ?? body.ticket_id) as string | undefined };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.error('Ticketing API timeout (15s)', {});
      return { success: false, error: 'Ticketing system timeout' };
    }
    logger.error('Ticketing API request failed', { error: String(err) });
    return { success: false, error: String(err) };
  }
}

export async function wakeUp(): Promise<void> {
  const config = getConfig();
  if (!config) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    await fetch(`${config.url}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeout);
    logger.debug('Ticketing system wake-up ping sent');
  } catch {
    logger.debug('Ticketing wake-up ping failed (non-blocking)');
  }
}

export function isTicketingConfigured(): boolean {
  return getConfig() !== null;
}
