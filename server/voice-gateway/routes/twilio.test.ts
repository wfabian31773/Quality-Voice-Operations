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
}));
vi.mock('../../../platform/billing/guardrails', () => ({
  checkHourlyCallLimit: m.checkHourlyCallLimitMock,
  incrementHourlyCallCount: m.incrementHourlyCallCountMock,
  checkDailyMinuteCap: m.checkDailyMinuteCapMock,
}));
vi.mock('../../../platform/sms/SmsConversationService', () => m.smsService);
vi.mock('../../../platform/analytics/CsatSurveyService', () => m.csatService);

import twilioRouter from './twilio';

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
  m.getAgentConfigMock.mockResolvedValue(null);
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
});

describe('POST /twilio/outbound', () => {
  const base = { tenantId: 't1', agentId: 'a1', campaignId: 'camp1', contactId: 'c1', CallSid: 'CA1' };

  it('hangs up with 400 when tenant or agent is missing', async () => {
    const res = await form(request(app()).post('/twilio/outbound'), { tenantId: 't1' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('<Hangup/>');
  });

  it('connects the stream on the happy path', async () => {
    const res = await form(request(app()).post('/twilio/outbound'), base);
    expect(res.text).toContain('<Connect>');
    expect(res.text).toContain('name="agentType" value="outbound"');
    expect(res.text).toContain('name="campaignId" value="camp1"');
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

  it('records a CSAT reply and short-circuits without an auto-reply', async () => {
    m.lookupByPhoneNumberMock.mockResolvedValue({ tenantId: 't1', phoneNumberId: 'pn1' });
    m.csatService.tryRecordSmsCsatResponse = vi.fn().mockResolvedValue({ handled: true, csat: { id: 'cs1' } });
    const res = await form(request(app()).post('/twilio/sms'), { ...base, Body: '5' });
    expect(res.text).toContain('<Response></Response>');
    expect(m.smsService.getOrCreateConversation).not.toHaveBeenCalled();
  });
});
