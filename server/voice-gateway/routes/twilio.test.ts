import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  withPrivilegedClientMock: vi.fn(),
  lookupByPhoneNumberMock: vi.fn(),
  getAgentConfigMock: vi.fn(),
  buildPreTransferSayTwimlMock: vi.fn(),
  isDrainingMock: vi.fn(),
  handleTwilioStatusCallbackMock: vi.fn(),
  createPlatformPersistenceAdapterMock: vi.fn(),
  // campaigns
  updateContactStatusMock: vi.fn(),
  reconcileInboundCallbackMock: vi.fn(),
  resolveContactByCallSidMock: vi.fn(),
  checkCampaignCompletionMock: vi.fn(),
  classifyCallOutcomeMock: vi.fn(),
  addToDncMock: vi.fn(),
  isSmsOptOutMock: vi.fn(),
  getCampaignMock: vi.fn(),
  updateContactTypeDispositionMock: vi.fn(),
  // billing / guardrails
  checkBudgetMock: vi.fn(),
  checkHourlyCallLimitMock: vi.fn(),
  incrementHourlyCallCountMock: vi.fn(),
  checkDailyMinuteCapMock: vi.fn(),
  recordTwilioCallCostMock: vi.fn(),
  extractStirTelemetryMock: vi.fn(),
  createRateLimitCheckerMock: vi.fn(),
  recordDemoAnalyticsEventMock: vi.fn(),
  scheduleDemoDataCleanupMock: vi.fn(),
  isWebsiteDemoNumberMock: vi.fn(),
  authorizeHealthcareDeploymentMock: vi.fn(),
  // dynamic imports
  smsService: {} as Record<string, ReturnType<typeof vi.fn>>,
  csatService: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('../middleware/twilioSignature', () => ({
  twilioSignatureMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ query: m.poolQueryMock }),
  withPrivilegedClient: m.withPrivilegedClientMock,
  withTenantClient: async (_tenantId: string, fn: (c: { query: typeof m.poolQueryMock }) => Promise<unknown>) =>
    fn({ query: m.poolQueryMock }),
}));
vi.mock('../services/numberLookup', () => ({
  lookupByPhoneNumber: m.lookupByPhoneNumberMock,
  getAgentConfig: m.getAgentConfigMock,
}));
vi.mock('../services/agentLoader', () => ({ loadAgentConfig: vi.fn() }));
vi.mock('../services/preTransferGreeting', () => ({ buildPreTransferSayTwiml: m.buildPreTransferSayTwimlMock }));
vi.mock('../services/sessionManager', () => ({ sessionManager: { isDraining: m.isDrainingMock } }));
vi.mock('../../../platform/runtime/lifecycle/CallLifecycleCoordinator', () => ({
  CallLifecycleCoordinator: class {
    handleTwilioStatusCallback = m.handleTwilioStatusCallbackMock;
  },
}));
vi.mock('../services/callPersistence', () => ({ createPlatformPersistenceAdapter: m.createPlatformPersistenceAdapterMock }));
vi.mock('../../../platform/campaigns', () => ({
  updateContactStatus: m.updateContactStatusMock,
  reconcileInboundCallback: m.reconcileInboundCallbackMock,
  resolveContactByCallSid: m.resolveContactByCallSidMock,
  checkCampaignCompletion: m.checkCampaignCompletionMock,
  classifyCallOutcome: m.classifyCallOutcomeMock,
  addToDnc: m.addToDncMock,
  isSmsOptOut: m.isSmsOptOutMock,
  getCampaign: m.getCampaignMock,
  updateContactTypeDisposition: m.updateContactTypeDispositionMock,
}));
vi.mock('../../../platform/billing/budget/checkBudget', () => ({ checkBudget: m.checkBudgetMock }));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimitChecker: () => m.createRateLimitCheckerMock,
}));
vi.mock('../../../platform/telephony/stirAttestation', () => ({ extractStirTelemetry: m.extractStirTelemetryMock }));
vi.mock('../../../platform/billing/cost', () => ({ recordTwilioCallCost: m.recordTwilioCallCostMock }));
vi.mock('../../admin-api/routes/demo', () => ({
  recordDemoAnalyticsEvent: m.recordDemoAnalyticsEventMock,
  scheduleDemoDataCleanup: m.scheduleDemoDataCleanupMock,
  isWebsiteDemoNumber: m.isWebsiteDemoNumberMock,
  WEBSITE_DEMO_CALL_SID_KEY: 'websiteDemoCallSid',
}));
vi.mock('../../../platform/billing/guardrails', () => ({
  checkHourlyCallLimit: m.checkHourlyCallLimitMock,
  incrementHourlyCallCount: m.incrementHourlyCallCountMock,
  checkDailyMinuteCap: m.checkDailyMinuteCapMock,
}));
vi.mock('../../../platform/compliance/HealthcareDeploymentApprovalService', () => ({
  authorizeHealthcareDeployment: m.authorizeHealthcareDeploymentMock,
}));
vi.mock('../../../platform/sms/SmsConversationService', () => m.smsService);
vi.mock('../../../platform/analytics/CsatSurveyService', () => m.csatService);

import twilioRouter, { buildStreamUrl } from './twilio';

function app() {
  const a = express();
  a.use(express.urlencoded({ extended: false }));
  a.use(express.json());
  a.use(twilioRouter);
  return a;
}
const form = (r: request.Test, body: Record<string, string>) => r.type('form').send(body);

beforeEach(() => {
  for (const v of Object.values(m)) {
    if (typeof v === 'function' && 'mockReset' in v) (v as ReturnType<typeof vi.fn>).mockReset();
  }
  delete process.env.VOICE_GATEWAY_STREAM_TOKEN;
  delete process.env.VOICE_PUBLIC_BASE_URL;
  m.poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  m.withPrivilegedClientMock.mockImplementation(async (cb: (c: unknown) => Promise<void>) =>
    cb({ query: m.poolQueryMock }),
  );
  m.isDrainingMock.mockReturnValue(false);
  m.buildPreTransferSayTwimlMock.mockReturnValue('');
  m.reconcileInboundCallbackMock.mockResolvedValue(null);
  m.checkBudgetMock.mockResolvedValue({ allowed: true });
  m.checkHourlyCallLimitMock.mockReturnValue({ allowed: true });
  m.checkDailyMinuteCapMock.mockResolvedValue({ allowed: true });
  m.createRateLimitCheckerMock.mockReturnValue(true);
  m.extractStirTelemetryMock.mockReturnValue(null);
  m.classifyCallOutcomeMock.mockReturnValue('no_answer');
  m.isSmsOptOutMock.mockReturnValue(false);
  // promise-returning side-effect mocks (several are called fire-and-forget
  // with `.then`/`.catch`, so they must resolve rather than return undefined)
  m.updateContactStatusMock.mockResolvedValue(undefined);
  m.checkCampaignCompletionMock.mockResolvedValue(undefined);
  m.updateContactTypeDispositionMock.mockResolvedValue(undefined);
  m.getCampaignMock.mockResolvedValue(null);
  m.addToDncMock.mockResolvedValue(undefined);
  m.recordTwilioCallCostMock.mockResolvedValue(undefined);
  m.recordDemoAnalyticsEventMock.mockResolvedValue(undefined);
  m.resolveContactByCallSidMock.mockResolvedValue(null);
  m.getAgentConfigMock.mockResolvedValue({ type: 'general', metadata: {} });
  m.authorizeHealthcareDeploymentMock.mockResolvedValue({ allowed: true, code: 'not_healthcare' });
  // dynamic-import service shims
  m.smsService.getOrCreateConversation = vi.fn().mockResolvedValue({ id: 'conv-1', assigneeUserId: 'u1' });
  m.smsService.saveMessage = vi.fn().mockResolvedValue(undefined);
  m.smsService.logActivity = vi.fn().mockResolvedValue(undefined);
  m.smsService.logConsent = vi.fn().mockResolvedValue(undefined);
  m.smsService.evaluateAutoReplies = vi.fn().mockResolvedValue(null);
  m.smsService.evaluateAssignmentRules = vi.fn().mockResolvedValue(null);
  m.smsService.updateConversation = vi.fn().mockResolvedValue(undefined);
  m.csatService.tryRecordSmsCsatResponse = vi.fn().mockResolvedValue({ handled: false });
  m.csatService.markCsatOptedOut = vi.fn().mockResolvedValue(undefined);
});

describe('POST /twilio/voice', () => {
  const base = { CallSid: 'CA1', From: '+15551112222', To: '+15553334444' };

  it('rejects with a hangup TwiML when the server is draining', async () => {
    m.isDrainingMock.mockReturnValue(true);
    const res = await form(request(app()).post('/twilio/voice'), base);
    expect(res.status).toBe(200);
    expect(res.text).toContain('currently unavailable');
  });

  it('returns a not-configured message when no routing matches', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue(null);
    const res = await form(request(app()).post('/twilio/voice'), base);
    expect(res.text).toContain('not currently configured');
  });

  it('rejects suspended tenants', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', agentId: 'a1', agentType: 'inbound' });
    m.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM tenants') ? { rows: [{ status: 'suspended' }] } : { rows: [] },
    );
    const res = await form(request(app()).post('/twilio/voice'), base);
    expect(res.text).toContain('temporarily unavailable');
  });

  it('emits a Connect/Stream TwiML on the happy path', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({
      tenantId: 't1', agentId: 'a1', agentType: 'inbound', tenantName: 'Acme', agentName: 'Bot',
    });
    const res = await form(request(app()).post('/twilio/voice'), base);
    expect(res.text).toContain('<Connect>');
    expect(res.text).toContain('<Stream url="ws://');
    expect(res.text).toContain('name="tenantId" value="t1"');
    expect(m.incrementHourlyCallCountMock).toHaveBeenCalledWith('t1');
  });

  it('fails closed before streaming an unapproved healthcare inbound call', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({
      tenantId: 't1', agentId: 'a1', agentType: 'answering_service', tenantName: 'Clinic', agentName: 'AI Receptionist',
    });
    m.authorizeHealthcareDeploymentMock.mockResolvedValue({ allowed: false, code: 'approval_missing' });
    const res = await form(request(app()).post('/twilio/voice'), base);
    expect(res.text).toContain('not currently available');
    expect(res.text).not.toContain('<Stream');
    expect(m.incrementHourlyCallCountMock).not.toHaveBeenCalled();
    expect(m.authorizeHealthcareDeploymentMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', agentId: 'a1', agentType: 'answering_service', subjectPhone: base.From,
    }));
  });

  it('blocks the call when the hourly limit is exceeded', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', agentId: 'a1', agentType: 'inbound' });
    m.checkHourlyCallLimitMock.mockReturnValue({ allowed: false, reason: 'rate' });
    const res = await form(request(app()).post('/twilio/voice'), base);
    expect(res.text).toContain('Call limit reached');
  });

  it('returns a technical-difficulties message on unexpected errors', async () => {
    m.lookupByPhoneNumberMock.mockRejectedValue(new Error('boom'));
    const res = await form(request(app()).post('/twilio/voice'), base);
    expect(res.text).toContain('technical difficulties');
  });
});

describe('POST /twilio/status', () => {
  it('acknowledges with 204 for a non-terminal status', async () => {
    const res = await form(request(app()).post('/twilio/status'), { CallSid: 'CA1', CallStatus: 'in-progress' });
    expect(res.status).toBe(204);
  });

  it('updates the campaign contact on a terminal no-answer status', async () => {
    m.resolveContactByCallSidMock.mockResolvedValue({ tenantId: 't1', contactId: 'c1', campaignId: 'camp1' });
    const res = await form(request(app()).post('/twilio/status'), { CallSid: 'CA1', CallStatus: 'no-answer' });
    expect(res.status).toBe(204);
    expect(m.updateContactStatusMock).toHaveBeenCalled();
    expect(m.checkCampaignCompletionMock).toHaveBeenCalledWith('t1', 'camp1');
  });

  it('persists STIR telemetry when present', async () => {
    m.extractStirTelemetryMock.mockReturnValue({ status: 'TN-Validation-Passed', verstat: 'TN-Validation-Passed', attestation: 'A' });
    const res = await form(request(app()).post('/twilio/status'), { CallSid: 'CA1', CallStatus: 'completed' });
    expect(res.status).toBe(204);
    expect(m.withPrivilegedClientMock).toHaveBeenCalled();
  });
});

describe('demo tenant: website-demo marker and cleanup', () => {
  const demoRouting = { tenantId: 'demo', agentId: 'a1', phoneNumberId: 'pn1', tenantName: 'Demo', agentName: 'Bot' };

  async function callAndHangUp(callSid: string, ip: string) {
    await form(request(app()).post('/twilio/voice').set('X-Forwarded-For', ip), {
      CallSid: callSid, From: '+15551112222', To: '+15553334444',
    });
    m.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT id FROM call_sessions') ? { rows: [{ id: `sess-${callSid}` }] } : { rows: [] },
    );
    await form(request(app()).post('/twilio/status'), { CallSid: callSid, CallStatus: 'completed' });
  }

  it('an ordinary call to a demo-tenant number (Sharp Line) is not marked and never scheduled for cleanup', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ ...demoRouting, agentType: 'barbershop' });
    m.isWebsiteDemoNumberMock.mockResolvedValue(false);
    await callAndHangUp('CA-sharp', '10.0.0.1');
    expect(m.isWebsiteDemoNumberMock).toHaveBeenCalledWith('pn1', 'barbershop');
    expect(m.recordDemoAnalyticsEventMock).toHaveBeenCalledWith('call_started', expect.any(String), 'barbershop', undefined, undefined, undefined);
    expect(m.scheduleDemoDataCleanupMock).not.toHaveBeenCalled();
  });

  it('a website-demo call is marked with its CallSid and scheduled for cleanup', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ ...demoRouting, agentType: 'dental' });
    m.isWebsiteDemoNumberMock.mockResolvedValue(true);
    await callAndHangUp('CA-web', '10.0.0.2');
    expect(m.recordDemoAnalyticsEventMock).toHaveBeenCalledWith(
      'call_started', expect.any(String), 'dental', undefined, undefined, { websiteDemoCallSid: 'CA-web' },
    );
    expect(m.scheduleDemoDataCleanupMock).toHaveBeenCalledWith('sess-CA-web');
  });
});

describe('POST /twilio/sms-status', () => {
  it('returns 400 when the SID or status is missing', async () => {
    const res = await form(request(app()).post('/twilio/sms-status'), { MessageStatus: 'delivered' });
    expect(res.status).toBe(400);
  });

  it('acknowledges 204 for a known delivered SID', async () => {
    m.poolQueryMock.mockResolvedValue({ rowCount: 1, rows: [{ tenant_id: 't1', integration_id: 'i1', dispatch_id: 'd1' }] });
    const res = await form(request(app()).post('/twilio/sms-status'), { MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(res.status).toBe(204);
  });

  it('acknowledges 204 for an unknown SID', async () => {
    m.poolQueryMock.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await form(request(app()).post('/twilio/sms-status'), { MessageSid: 'SMx', MessageStatus: 'failed' });
    expect(res.status).toBe(204);
  });

  it('returns 500 when the update throws', async () => {
    m.poolQueryMock.mockRejectedValue(new Error('db down'));
    const res = await form(request(app()).post('/twilio/sms-status'), { MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(res.status).toBe(500);
  });

  it('passes ?mid= with To/From/AccountSid so a SID-less row of the same tenant gets its SID', async () => {
    m.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, tenant_id, to_number, from_number FROM sms_messages/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 'msg-1', tenant_id: 't1', to_number: '+13125550142', from_number: '+13125550100' }] };
      }
      if (/FROM connectors WHERE tenant_id/.test(sql)) {
        return { rowCount: 1, rows: [{ config: { credentials: { account_sid: 'AC_T1', auth_token: 'x' } } }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const res = await form(request(app()).post('/twilio/sms-status?mid=msg-1'), {
      MessageSid: 'SM1',
      MessageStatus: 'sent',
      To: '+13125550142',
      From: '+13125550100',
      AccountSid: 'AC_T1',
    });
    expect(res.status).toBe(204);
    const attach = m.poolQueryMock.mock.calls.find(([sql]) => /SET twilio_sid = \$3/.test(String(sql)));
    expect(attach?.[1]).toEqual(['msg-1', 't1', 'SM1', 'SEND_OUTCOME_UNKNOWN']);
  });

  it('does not attach a SID when the callback account belongs to another tenant', async () => {
    m.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, tenant_id, to_number, from_number FROM sms_messages/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 'msg-1', tenant_id: 't1', to_number: '+13125550142', from_number: '+13125550100' }] };
      }
      if (/FROM connectors WHERE tenant_id/.test(sql)) {
        return { rowCount: 1, rows: [{ config: { credentials: { account_sid: 'AC_T1', auth_token: 'x' } } }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const res = await form(request(app()).post('/twilio/sms-status?mid=msg-1'), {
      MessageSid: 'SM1',
      MessageStatus: 'sent',
      To: '+13125550142',
      From: '+13125550100',
      AccountSid: 'AC_OTHER',
    });
    expect(res.status).toBe(204);
    expect(m.poolQueryMock.mock.calls.some(([sql]) => /SET twilio_sid = \$3/.test(String(sql)))).toBe(false);
  });
});

describe('POST /twilio/outbound', () => {
  const base = { tenantId: 't1', agentId: 'a1', campaignId: 'camp1', contactId: 'c1', CallSid: 'CA1' };

  it('hangs up with 400 when tenant or agent is missing', async () => {
    const res = await form(request(app()).post('/twilio/outbound'), { tenantId: 't1' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('<Hangup/>');
  });

  it('connects the stream on the happy path', async () => {
    process.env.VOICE_GATEWAY_STREAM_TOKEN = 'outbound-tok&x';
    const res = await form(request(app()).post('/twilio/outbound'), base);
    expect(res.text).toContain('<Connect>');
    expect(res.text).toContain('name="agentType" value="outbound"');
    expect(res.text).toContain('name="campaignId" value="camp1"');
    expect(res.text).toContain('<Parameter name="token" value="outbound-tok&amp;x"');
    expect(res.text).not.toMatch(/<Stream url="[^"]*\?/);
  });

  it('fails closed before streaming an unapproved outbound healthcare call', async () => {
    m.getAgentConfigMock.mockResolvedValue({ type: 'healthcare-receptionist', metadata: {} });
    m.authorizeHealthcareDeploymentMock.mockResolvedValue({ allowed: false, code: 'approval_expired' });
    const res = await form(request(app()).post('/twilio/outbound'), { ...base, To: '+15551234567' });
    expect(res.text).toContain('<Hangup/>');
    expect(res.text).not.toContain('<Stream');
    expect(m.incrementHourlyCallCountMock).not.toHaveBeenCalled();
    expect(m.authorizeHealthcareDeploymentMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', agentId: 'a1', agentType: 'healthcare-receptionist', subjectPhone: '+15551234567',
    }));
  });

  it('leaves a voicemail when an answering machine is detected', async () => {
    m.getAgentConfigMock.mockResolvedValue({ metadata: { voicemailMessage: 'Please call us back' } });
    m.classifyCallOutcomeMock.mockReturnValue('voicemail');
    const res = await form(request(app()).post('/twilio/outbound'), { ...base, AnsweredBy: 'machine_end_beep' });
    expect(res.text).toContain('Please call us back');
    expect(m.updateContactStatusMock).toHaveBeenCalled();
  });

  it('hangs up when blocked by the budget check', async () => {
    m.checkBudgetMock.mockResolvedValue({ allowed: false, reason: 'over budget' });
    const res = await form(request(app()).post('/twilio/outbound'), base);
    expect(res.text).toContain('<Hangup/>');
    expect(res.text).not.toContain('<Connect>');
  });
});

describe('POST /twilio/sms', () => {
  const base = { Body: 'hello', From: '+15551112222', To: '+15553334444', MessageSid: 'SM1' };

  it('returns an empty Response when no routing matches', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue(null);
    const res = await form(request(app()).post('/twilio/sms'), base);
    expect(res.text).toContain('<Response></Response>');
  });

  it('returns a Message TwiML when an auto-reply matches', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', phoneNumberId: 'pn1' });
    m.smsService.getOrCreateConversation = vi.fn().mockResolvedValue({ id: 'conv-1', assigneeUserId: 'u1' });
    m.smsService.evaluateAutoReplies = vi.fn().mockResolvedValue('Thanks for your message');
    const res = await form(request(app()).post('/twilio/sms'), base);
    expect(res.text).toContain('<Message>Thanks for your message</Message>');
  });

  it('processes an opt-out by adding the number to the DNC list', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', phoneNumberId: 'pn1' });
    m.isSmsOptOutMock.mockReturnValue(true);
    const res = await form(request(app()).post('/twilio/sms'), { ...base, Body: 'STOP' });
    expect(res.status).toBe(200);
    expect(m.addToDncMock).toHaveBeenCalledWith('t1', '+15551112222', 'sms', expect.any(String));
  });

  it.each(['START', ' unstop '])('records %s as opt_in and lifts the SMS-sourced DNC entry', async (keyword) => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', phoneNumberId: 'pn1' });
    m.poolQueryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await form(request(app()).post('/twilio/sms'), { ...base, Body: keyword });
    expect(res.status).toBe(200);
    expect(m.smsService.logConsent).toHaveBeenCalledWith('t1', '+15551112222', 'opt_in', keyword.trim(), 'inbound_sms', 'SM1');
    const dncDelete = m.poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM dnc_list'));
    expect(dncDelete?.[0]).toContain("source = 'sms'");
    expect(dncDelete?.[1]).toEqual(['t1', '+15551112222']);
    expect(m.addToDncMock).not.toHaveBeenCalled();
  });

  it('does not treat ordinary messages as opt-in', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', phoneNumberId: 'pn1' });
    await form(request(app()).post('/twilio/sms'), { ...base, Body: 'start time?' });
    expect(m.smsService.logConsent).not.toHaveBeenCalled();
    expect(m.poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('dnc_list'))).toBe(false);
  });

  it('STOP then START re-enables chokepoint sends; STOP alone keeps them refused', async () => {
    // The consent rows the route writes are what sms.send reads (latest opt_in/opt_out wins).
    const consentLog: Array<{ phone: string; action: string }> = [];
    m.smsService.logConsent = vi.fn(async (_t: string, phone: string, action: string) => {
      consentLog.push({ phone, action });
    });
    m.isSmsOptOutMock.mockImplementation((b: string) => b.trim().toLowerCase() === 'stop');
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', phoneNumberId: 'pn1' });

    const { createSmsSendAction, sendSystemSms } = await import('../../../platform/actions/sms/send');
    const { createMemoryStore } = await import('../../../platform/actions/core');
    const transport = { defaultFromNumber: vi.fn(async () => '+15553334444'), send: vi.fn(async () => ({ sid: 'SMx' })) };
    const action = createSmsSendAction({
      store: {
        isTenantMessagingEnabled: async () => true,
        isTenantSender: async () => true,
        loadStoredOutbound: async () => null,
        latestConsentAction: async (_tx, _t, phone) =>
          (consentLog.filter((c) => c.phone === phone && c.action !== 'help_request').at(-1)?.action ?? null) as
            | 'opt_in'
            | 'opt_out'
            | null,
        reserveOutbound: async () => ({ reserved: true }),
        reserveDeferredSend: async () => ({ reserved: true }),
        insertOutbound: async () => {},
        updateOutbound: async () => {},
        claimDueDeferred: async () => [],
      },
      transport,
      quietHours: { isAllowed: async () => true, nextWindowStart: async (_t, _to, now) => now },
      config: {
        smsEnabled: () => true,
        liveCallExemptSeconds: () => 60,
        rateLimit: () => ({ max: 0, windowMs: 0 }),
        statusCallbackUrl: () => null,
      },
    });
    const memory = createMemoryStore();
    const runtime = { store: memory, withTenantTx: memory.withTenantTx.bind(memory) };
    const send = () =>
      sendSystemSms(
        { tenantId: 't1', to: '+15551112222', templateKey: 'directions', vars: { businessName: 'Fade Lab', address: '12 Main St' }, purpose: 'transactional' },
        { action, runtime },
      );

    await form(request(app()).post('/twilio/sms'), { ...base, Body: 'STOP', MessageSid: 'SM-stop' });
    const refused = await send();
    expect(refused.ok ? null : refused.error.code).toBe('RECIPIENT_OPTED_OUT');
    expect(transport.send).not.toHaveBeenCalled();

    await form(request(app()).post('/twilio/sms'), { ...base, Body: 'START', MessageSid: 'SM-start' });
    expect(consentLog.map((c) => c.action)).toEqual(['opt_out', 'opt_in']);
    const sent = await send();
    expect(sent).toMatchObject({ ok: true, data: { status: 'queued' } });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('records a CSAT reply and short-circuits without an auto-reply', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', phoneNumberId: 'pn1' });
    m.csatService.tryRecordSmsCsatResponse = vi.fn().mockResolvedValue({ handled: true, csat: { id: 'cs1' } });
    const res = await form(request(app()).post('/twilio/sms'), { ...base, Body: '5' });
    expect(res.text).toContain('<Response></Response>');
    expect(m.smsService.getOrCreateConversation).not.toHaveBeenCalled();
  });
});

describe('PR-00 drain + direct voice hosting', () => {
  const base = { CallSid: 'CA1', From: '+15551112222', To: '+15553334444' };
  const routing = { tenantId: 't1', agentId: 'a1', agentType: 'inbound', tenantName: 'Acme', agentName: 'Bot' };

  it('redirects a new call to VOICE_PUBLIC_BASE_URL/twilio/voice while draining', async () => {
    process.env.VOICE_PUBLIC_BASE_URL = 'https://voice.example.com/';
    m.isDrainingMock.mockReturnValue(true);
    const res = await form(request(app()).post('/twilio/voice'), base);
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      '<Redirect method="POST">https://voice.example.com/twilio/voice?qvoDrainRedirect=1</Redirect>',
    );
    expect(res.text).not.toContain('<Hangup/>');
    expect(m.lookupByPhoneNumberMock).not.toHaveBeenCalled();
  });

  it('does not redirect twice: an already-redirected call gets the unavailable message', async () => {
    process.env.VOICE_PUBLIC_BASE_URL = 'https://voice.example.com';
    m.isDrainingMock.mockReturnValue(true);
    const res = await form(request(app()).post('/twilio/voice?qvoDrainRedirect=1'), base);
    expect(res.text).toContain('currently unavailable');
    expect(res.text).not.toContain('<Redirect');
  });

  it('a redirected call is handled normally once it lands on a non-draining instance', async () => {
    process.env.VOICE_PUBLIC_BASE_URL = 'https://voice.example.com';
    m.lookupByPhoneNumberMock.mockResolvedValue(routing);
    const res = await form(request(app()).post('/twilio/voice?qvoDrainRedirect=1'), base);
    expect(res.text).toContain('<Stream url="wss://voice.example.com/twilio/stream"');
  });

  it('builds the <Stream> URL from VOICE_PUBLIC_BASE_URL, ignoring forwarded headers', async () => {
    process.env.VOICE_PUBLIC_BASE_URL = 'https://voice.example.com';
    process.env.VOICE_GATEWAY_STREAM_TOKEN = 'tok/with+chars';
    m.lookupByPhoneNumberMock.mockResolvedValue(routing);
    const res = await form(
      request(app()).post('/twilio/voice').set('x-forwarded-host', 'evil.example').set('x-forwarded-proto', 'http'),
      base,
    );
    expect(res.text).toContain('<Stream url="wss://voice.example.com/twilio/stream"');
    expect(res.text).not.toContain('?token=');
    expect(res.text).toContain('<Parameter name="token" value="tok/with+chars"');
    expect(res.text).not.toContain('evil.example');
    expect(res.text).not.toContain('/vg/');
  });

  it('keeps the Replit forwarded-header path with the /vg prefix when VOICE_PUBLIC_BASE_URL is unset', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue(routing);
    const res = await form(
      request(app()).post('/twilio/voice').set('x-forwarded-host', 'qvo.replit.app').set('x-forwarded-proto', 'https,http'),
      base,
    );
    expect(res.text).toContain('<Stream url="wss://qvo.replit.app/vg/twilio/stream"');
  });

  it('buildStreamUrl maps http → ws for a plain-http public base', () => {
    process.env.VOICE_PUBLIC_BASE_URL = 'http://localhost:3001';
    expect(buildStreamUrl({ headers: {}, protocol: 'http' } as never)).toBe('ws://localhost:3001/twilio/stream');
  });
});
