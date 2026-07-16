/**
 * Self-contained browser proof for GTM-006 / WP4.
 *
 * Starts a deterministic tenant API fixture and the real Vite application,
 * logs in through the real UI, opens the healthcare call outcome, follows the
 * real ticket link, and advances the follow-up status. No database, Twilio, or
 * OpenAI credentials are required; credentialed audio proof remains WP6.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const WEB_PORT = 5179;
const API_PORT = 3012;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function token(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    sub: 'user-1', tenantId: 'tenant-1', email: 'owner@clinic.test', role: 'tenant_owner',
    isPlatformAdmin: false, exp: Math.floor(Date.now() / 1000) + 3600,
  })}.fixture`;
}

const projection = {
  callId: 'call-1', language: 'es', lifecycleState: 'CALL_COMPLETED',
  startedAt: '2026-07-12T10:00:00.000Z', endedAt: '2026-07-12T10:03:00.000Z',
  caller: { firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100', type: 'patient', organizationName: null },
  patient: { firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100' },
  intent: 'Needs an annual eye exam',
  outcome: {
    type: 'appointment_request', summary: 'Appointment request for an annual eye exam. Staff confirmation required.',
    requestedAction: 'Call back to arrange an annual eye exam time', urgency: 'routine',
    callbackPreference: 'weekday afternoons', identityVerificationStatus: 'partially_verified',
    consentToContact: true, evidenceSource: ['caller_statement', 'caller_id'],
  },
  transcript: { available: true, lineCount: 2 },
  recording: { policy: 'disabled', status: 'not_recorded', url: null },
  delivery: { id: 'out-1', status: 'sent', error: null, externalReference: 'EXT-10' },
  followUp: {
    ticketId: 'ticket-1', ticketNumber: 17, ownerId: null, ownerLabel: 'Unassigned',
    priority: 'medium', status: 'open', nextAction: 'Call back to arrange an annual eye exam time',
  },
  tool: { id: 'tool-1', name: 'createServiceTicket', status: 'success', error: null, invokedAt: '2026-07-12T10:02:00.000Z', result: { success: true } },
  escalation: null,
  operationalValue: { state: 'staff_follow_up_created', evidence: 'A staff follow-up ticket was created.' },
};

let ticketStatus = 'open';

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const apiServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${API_PORT}`);
  const path = url.pathname;
  if (req.method === 'OPTIONS') return json(res, {});
  if (req.method === 'POST' && path === '/auth/login') {
    return json(res, { token: token(), userId: 'user-1', tenantId: 'tenant-1', email: 'owner@clinic.test', role: 'tenant_owner', isPlatformAdmin: false });
  }
  if (path === '/auth/me') return json(res, { user: { userId: 'user-1', tenantId: 'tenant-1', email: 'owner@clinic.test', role: 'tenant_owner', isPlatformAdmin: false } });
  if (path === '/tenants/me') return json(res, { tenant: { id: 'tenant-1', name: 'Northstar Clinic', slug: 'northstar', status: 'active', plan: 'pro', billing_currency: 'usd', created_at: '2026-01-01T00:00:00Z' } });
  if (path === '/tenants/me/provisioning-status') return json(res, { status: 'active', complete: true });
  if (path === '/call-saved-views' || path === '/call-saved-views/pinned') return json(res, { views: [] });
  if (path === '/agents') return json(res, { agents: [{ id: 'agent-1', name: 'Healthcare Receptionist' }] });
  if (path === '/calls/call-1/outcome') return json(res, { projection });
  if (path === '/calls/call-1/transcript') return json(res, { transcript: [
    { id: 'line-1', role: 'user', content: 'Necesito una cita.', sequence_number: 0, occurred_at: '2026-07-12T10:01:00Z' },
    { id: 'line-2', role: 'assistant', content: 'Puedo tomar la solicitud.', sequence_number: 1, occurred_at: '2026-07-12T10:01:02Z' },
  ] });
  if (path === '/calls/call-1/events') return json(res, { events: [] });
  if (path === '/calls/call-1') return json(res, { call: {
    id: 'call-1', caller_number: '[PHONE_REDACTED]', called_number: '[PHONE_REDACTED]', direction: 'inbound',
    lifecycle_state: 'CALL_COMPLETED', start_time: '2026-07-12T10:00:00Z', end_time: '2026-07-12T10:03:00Z',
    agent_id: 'agent-1', agent_name: 'Healthcare Receptionist', duration_seconds: 180, language: 'es',
  }, costBreakdown: null, currency: 'USD' });
  if (path === '/calls') return json(res, { calls: [{
    id: 'call-1', caller_number: '[PHONE_REDACTED]', called_number: '[PHONE_REDACTED]', direction: 'inbound',
    lifecycle_state: 'CALL_COMPLETED', start_time: '2026-07-12T10:00:00Z', end_time: '2026-07-12T10:03:00Z',
    agent_id: 'agent-1', agent_name: 'Healthcare Receptionist', duration_seconds: 180, language: 'es',
    outcome_type: 'appointment_request', next_action: 'Call back to arrange an annual eye exam time', ticket_id: 'ticket-1',
  }], total: 1 });
  if (path === '/tool-executions') return json(res, { executions: [{ id: 'tool-1', toolName: 'createServiceTicket', status: 'success', durationMs: 42, invokedAt: '2026-07-12T10:02:00Z', errorMessage: null, recoveryAction: null, result: { success: true } }] });
  if (req.method === 'PUT' && path === '/tickets/ticket-1') {
    const body = await readBody(req);
    if (typeof body.status === 'string') ticketStatus = body.status;
    return json(res, { ticket: { id: 'ticket-1', status: ticketStatus } });
  }
  if (path === '/tickets/ticket-1/activity') return json(res, { activities: [] });
  if (path === '/tickets/ticket-1') return json(res, {
    ticket: {
      id: 'ticket-1', call_id: 'call-1', ticket_number: 17, subject: 'Service Request: Annual eye exam',
      description: 'Appointment request; staff confirmation required.', status: ticketStatus, priority: 'medium',
      assignee_user_id: null, assignee_email: null, category_id: null, category_name: null, department: 'answering_service',
      tags: ['answering-service', 'outcome:appointment_request'], source: 'phone', contact_name: 'Ana Lopez',
      contact_email: '', contact_phone: '+15555550100', notes: '', first_response_at: null, resolved_at: null,
      closed_at: null, reopened_count: 0, created_by_user_id: null, created_by_email: null,
      created_at: '2026-07-12T10:02:00Z', updated_at: '2026-07-12T10:02:00Z',
    }, watchers: [], sla: null, linkedTickets: [], attachments: [], receptionistOutcome: {
      ...projection,
      followUp: { ...projection.followUp, status: ticketStatus },
    },
  });
  if (path === '/users') return json(res, { users: [{ id: 'user-1', email: 'owner@clinic.test' }] });
  if (path === '/ticket-categories') return json(res, { categories: [] });
  if (path === '/ticket-macros') return json(res, { macros: [] });
  if (path === '/ticket-templates') return json(res, { templates: [] });
  if (path === '/notifications') return json(res, { notifications: [], unreadCount: 0 });
  if (path === '/phone-numbers') return json(res, { phoneNumbers: [] });
  return json(res, {});
});

async function main() {
await new Promise<void>((resolve, reject) => {
  apiServer.once('error', reject);
  apiServer.listen(API_PORT, '127.0.0.1', resolve);
});

const vite = await createViteServer({
  configFile: new URL('../../client-app/vite.config.ts', import.meta.url).pathname,
  server: {
    port: WEB_PORT,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') } },
  },
});

await vite.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('PAGE ERROR', error));

try {
  await page.goto(`${BASE_URL}/login?next=%2Fcalls`, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-email', 'owner@clinic.test');
  await page.fill('#login-password', 'fixture-password');
  await Promise.all([
    page.waitForURL(`${BASE_URL}/calls`, { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);

  await page.getByTestId('tenant-calls-list').waitFor({ state: 'visible' });
  assert(await page.getByText('appointment request', { exact: true }).count() === 1, 'Calls list must show the structured appointment request');
  await page.getByText('appointment request', { exact: true }).click();

  await page.getByTestId('healthcare-outcome-card').waitFor({ state: 'visible', timeout: 5_000 });
  assert(await page.getByText('Not Recorded', { exact: true }).count() === 1, 'Call drawer must show truthful recording policy state');
  assert(await page.getByText('Call back to arrange an annual eye exam time', { exact: true }).count() >= 1, 'Call drawer must show the staff next action');
  assert(await page.getByText('Appointment Booked', { exact: true }).count() === 0, 'Appointment request must not be presented as a booking');

  const followUpLink = page.getByRole('link', { name: 'Open follow-up ticket' });
  assert(await followUpLink.getAttribute('href') === '/tickets/ticket-1', 'Outcome must link to the focused ticket route');
  await followUpLink.click();
  await page.waitForTimeout(250);
  assert(new URL(page.url()).pathname === '/tickets/ticket-1', 'Follow-up link must navigate to the focused ticket detail');
  await page.getByTestId('ticket-detail-loaded').waitFor({ state: 'visible', timeout: 5_000 });
  assert(await page.getByTestId('healthcare-outcome-card').count() === 1, 'Ticket detail must retain the receptionist evidence card');

  const selects = page.getByTestId('ticket-detail-loaded').locator('select');
  const selectCount = await selects.count();
  assert(selectCount >= 1, 'Ticket detail must expose an editable status control to the tenant owner');
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith('/api/tickets/ticket-1')),
    selects.nth(0).selectOption('in_progress', { timeout: 5_000 }),
  ]);
  assert(ticketStatus === 'in_progress', 'Staff must be able to advance follow-up status inside the focused portal');
  const ticketOutcomeCard = page.getByTestId('healthcare-outcome-card');
  await ticketOutcomeCard.getByText('In Progress', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });

  console.log('PASS healthcare outcome staff follow-up browser proof');
  const inspectionHoldMs = Number(process.env.E2E_INSPECTION_HOLD_MS ?? 0);
  if (inspectionHoldMs > 0) await page.waitForTimeout(inspectionHoldMs);
} catch (error) {
  console.error('Healthcare outcome browser proof failed before cleanup', error);
  throw error;
} finally {
  await Promise.race([browser.close(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  await Promise.race([vite.close(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  await Promise.race([
    new Promise<void>((resolve) => apiServer.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
