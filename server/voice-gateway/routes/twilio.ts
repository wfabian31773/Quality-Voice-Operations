import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { redactPHI } from '../../../platform/core/phi/redact';
import { lookupByPhoneNumber, getAgentConfig } from '../services/numberLookup';
import { loadAgentConfig } from '../services/agentLoader';
import { sessionManager } from '../services/sessionManager';
import { CallLifecycleCoordinator } from '../../../platform/runtime/lifecycle/CallLifecycleCoordinator';
import { createPlatformPersistenceAdapter } from '../services/callPersistence';
import type { TwilioTransferAdapter } from '../services/escalation';
import { twilioSignatureMiddleware } from '../middleware/twilioSignature';
import {
  updateContactStatus,
  reconcileInboundCallback,
  resolveContactByCallSid,
  checkCampaignCompletion,
  classifyCallOutcome,
  addToDnc,
  isSmsOptOut,
  getCampaign,
  updateContactTypeDisposition,
} from '../../../platform/campaigns';
import type { ContactStatus, ContactOutcome } from '../../../platform/campaigns';
import { checkBudget } from '../../../platform/billing/budget/checkBudget';
import { createRateLimitChecker } from '../../../platform/infra/rate-limit/createRateLimiter';
import { getPlatformPool, withPrivilegedClient } from '../../../platform/db';
import { extractStirTelemetry } from '../../../platform/telephony/stirAttestation';
import crypto from 'crypto';
import { recordDemoAnalyticsEvent, scheduleDemoDataCleanup } from '../../admin-api/routes/demo';
import {
  checkHourlyCallLimit,
  incrementHourlyCallCount,
  checkDailyMinuteCap,
} from '../../../platform/billing/guardrails';

const logger = createLogger('TWILIO_WEBHOOK');

const DEMO_TENANT_ID = 'demo';

const isDemoCallAllowed = createRateLimitChecker({
  windowMs: 60 * 60 * 1000,
  maxRequests: 5,
});

const activeDemoCalls = new Map<string, { callSid: string; startedAt: number; ipHash: string; agentType?: string }>();
const DEMO_ACTIVE_CALL_TTL_MS = 4 * 60 * 1000;

function getDemoCallerIp(req: import('express').Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  return typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : Array.isArray(forwarded)
      ? forwarded[0]
      : req.socket?.remoteAddress ?? 'unknown';
}

function getDemoCallKey(req: import('express').Request): string {
  return `demo-call:${getDemoCallerIp(req)}`;
}

function cleanStaleDemoCallEntries(): void {
  const now = Date.now();
  for (const [key, entry] of activeDemoCalls) {
    if (now - entry.startedAt > DEMO_ACTIVE_CALL_TTL_MS) {
      activeDemoCalls.delete(key);
    }
  }
}

setInterval(cleanStaleDemoCallEntries, 60_000);

function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

async function incrementDemoCallCount(): Promise<void> {
  try {
    const pool = getPlatformPool();
    await pool.query(
      `UPDATE tenants SET demo_call_count = COALESCE(demo_call_count, 0) + 1 WHERE id = $1`,
      [DEMO_TENANT_ID],
    );
  } catch (err) {
    logger.warn('Failed to increment demo call count', { error: String(err) });
  }
}

const tenantCoordinators = new Map<string, CallLifecycleCoordinator>();

function getCoordinator(tenantId: string): CallLifecycleCoordinator {
  if (!tenantCoordinators.has(tenantId)) {
    const persistence = createPlatformPersistenceAdapter(tenantId);
    tenantCoordinators.set(tenantId, new CallLifecycleCoordinator(tenantId, persistence));
  }
  return tenantCoordinators.get(tenantId)!;
}

let twilioAdapterInstance: TwilioTransferAdapter | undefined;

export function setTwilioAdapter(adapter: TwilioTransferAdapter): void {
  twilioAdapterInstance = adapter;
}

export function getTwilioAdapter(): TwilioTransferAdapter | undefined {
  return twilioAdapterInstance;
}

async function resolveTenantPlan(tenantId: string): Promise<'trial' | 'starter' | 'pro' | 'enterprise'> {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT plan, status FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    if (rows.length === 0 || rows[0].status === 'trialing') return 'trial';
    return (rows[0].plan as 'starter' | 'pro' | 'enterprise') || 'starter';
  } catch {
    return 'starter';
  }
}

async function checkTenantSuspended(tenantId: string): Promise<boolean> {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return rows.length > 0 && rows[0].status === 'suspended';
  } catch {
    return false;
  }
}

const router = Router();

router.use('/twilio/voice', twilioSignatureMiddleware);
router.use('/twilio/status', twilioSignatureMiddleware);
router.use('/twilio/outbound', twilioSignatureMiddleware);
router.use('/twilio/sms', twilioSignatureMiddleware);

router.post('/twilio/voice', async (req: Request, res: Response) => {
  const callSid = req.body.CallSid as string;
  const callerNumber = req.body.From as string;
  const calledNumber = req.body.To as string;

  logger.info('Inbound call received', {
    callSid,
    callerPhone: redactPHI(callerNumber),
    calledNumber: redactPHI(calledNumber),
  });

  if (sessionManager.isDraining()) {
    logger.warn('Rejecting call — server is draining', { callSid });
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>We are currently unavailable. Please try again shortly.</Say><Hangup/></Response>`,
    );
    return;
  }

  try {
    const routing = await lookupByPhoneNumber(calledNumber);

    if (!routing) {
      logger.warn('No routing found, rejecting call', { calledNumber: redactPHI(calledNumber), callSid });
      res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>This number is not currently configured. Goodbye.</Say><Hangup/></Response>`,
      );
      return;
    }

    const { tenantId, agentId, agentType } = routing;

    if (await checkTenantSuspended(tenantId)) {
      logger.warn('Call rejected — tenant suspended', { tenantId, callSid });
      res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>This service is temporarily unavailable. Please contact support.</Say><Hangup/></Response>`,
      );
      return;
    }

    if (tenantId === DEMO_TENANT_ID) {
      const visitorIp = getDemoCallerIp(req);
      const ipHash = hashIp(visitorIp);
      const rateLimitKey = getDemoCallKey(req);

      cleanStaleDemoCallEntries();
      if (activeDemoCalls.has(visitorIp)) {
        logger.warn('Demo call rejected — already has active call from this IP', {
          callSid,
          callerPhone: redactPHI(callerNumber),
        });
        res.type('text/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>You already have an active demo call. Please wait for it to finish before starting another.</Say><Hangup/></Response>`,
        );
        return;
      }

      if (!isDemoCallAllowed(rateLimitKey)) {
        logger.warn('Demo call rate limit exceeded', {
          callSid,
          callerPhone: redactPHI(callerNumber),
        });
        res.type('text/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Thank you for your interest in Voice AI. You have reached the maximum number of demo calls per hour. Please try again later.</Say><Hangup/></Response>`,
        );
        return;
      }

      activeDemoCalls.set(visitorIp, { callSid, startedAt: Date.now(), ipHash, agentType });
      incrementDemoCallCount();
      recordDemoAnalyticsEvent('call_started', ipHash, agentType).catch(() => {});
    }

    if (tenantId !== DEMO_TENANT_ID) {
      const plan = await resolveTenantPlan(tenantId);

      const hourlyCheck = checkHourlyCallLimit(tenantId, plan);
      if (!hourlyCheck.allowed) {
        logger.warn('Inbound call blocked by hourly rate limit', { tenantId, callSid, reason: hourlyCheck.reason });
        res.type('text/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Call limit reached. Please try again later.</Say><Hangup/></Response>`,
        );
        return;
      }

      const dailyCheck = await checkDailyMinuteCap(tenantId, plan);
      if (!dailyCheck.allowed) {
        logger.warn('Inbound call blocked by daily minute cap', { tenantId, callSid, reason: dailyCheck.reason });
        res.type('text/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Daily call limit reached. Service will resume tomorrow.</Say><Hangup/></Response>`,
        );
        return;
      }

      const budgetResult = await checkBudget(tenantId);
      if (!budgetResult.allowed) {
        logger.warn('Inbound call blocked by budget check', { tenantId, callSid, reason: budgetResult.reason });
        res.type('text/xml').send(
          `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Service limit reached. Please contact your administrator.</Say><Hangup/></Response>`,
        );
        return;
      }

      incrementHourlyCallCount(tenantId);
    }

    let campaignParams = '';
    try {
      const reconciliation = await reconcileInboundCallback(tenantId, callerNumber);
      if (reconciliation) {
        logger.info('Inbound call matched to campaign contact', {
          callSid,
          campaignId: reconciliation.campaignId,
          contactId: reconciliation.contactId,
        });
        campaignParams = `
      <Parameter name="campaignId" value="${reconciliation.campaignId}" />
      <Parameter name="contactId" value="${reconciliation.contactId}" />`;
      }
    } catch (err) {
      logger.warn('Callback reconciliation lookup failed — continuing without', { callSid, error: String(err) });
    }

    const wsProtocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3001';
    const streamToken = process.env.VOICE_GATEWAY_STREAM_TOKEN;
    const tokenParam = streamToken ? `?token=${encodeURIComponent(streamToken)}` : '';
    const wsUrl = `${wsProtocol}://${host}/twilio/stream${tokenParam}`;

    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="tenantId" value="${tenantId}" />
      <Parameter name="agentId" value="${agentId}" />
      <Parameter name="agentType" value="${agentType}" />
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="callerNumber" value="${callerNumber}" />
      <Parameter name="calledNumber" value="${calledNumber}" />${campaignParams}
    </Stream>
  </Connect>
</Response>`,
    );
  } catch (err) {
    logger.error('Error handling inbound call', {
      callSid,
      error: String(err),
    });
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>We are experiencing technical difficulties. Please try again later.</Say><Hangup/></Response>`,
    );
  }
});

function mapTwilioTerminalStatus(twilioStatus: string): { status: ContactStatus; outcome: ContactOutcome } | null {
  const terminalStatuses = ['no-answer', 'busy', 'canceled', 'failed'];
  if (!terminalStatuses.includes(twilioStatus)) return null;
  const outcome = classifyCallOutcome({
    twilioStatus,
    callDurationSeconds: 0,
    streamEstablished: false,
  });
  const status: ContactStatus = twilioStatus === 'no-answer' ? 'no_answer' : 'failed';
  return { status, outcome };
}

router.post('/twilio/status', async (req: Request, res: Response) => {
  const callSid = req.body.CallSid as string;
  const callStatus = req.body.CallStatus as string;
  const callDuration = parseInt(req.body.CallDuration as string, 10) || 0;

  logger.info('Twilio status callback', { callSid, callStatus });

  // Capture STIR/SHAKEN attestation telemetry from the carrier as soon as
  // we see it. Twilio sends `StirStatus` / `StirVerstat` on the same status
  // callbacks as the call lifecycle transitions, but they may arrive on
  // any of the in-progress / completed callbacks depending on how quickly
  // the terminating carrier reports back. We persist whatever is present
  // each time the callback fires so the Calls UI can warn on downgraded
  // attestation (B / C / failed) without waiting for `completed`.
  if (callSid) {
    const stir = extractStirTelemetry(req.body as Record<string, unknown>);
    if (stir) {
      try {
        await withPrivilegedClient(async (client) => {
          await client.query(
            `UPDATE call_sessions
                SET stir_status = COALESCE($2, stir_status),
                    stir_verstat = COALESCE($3, stir_verstat),
                    stir_attestation = COALESCE($4, stir_attestation),
                    updated_at = NOW()
              WHERE call_sid = $1`,
            [callSid, stir.status, stir.verstat, stir.attestation],
          );
        });
        logger.info('Recorded STIR telemetry for outbound call', {
          callSid,
          stirStatus: stir.status,
          stirAttestation: stir.attestation,
        });
      } catch (err) {
        logger.warn('Failed to persist STIR telemetry from status callback', {
          callSid,
          error: String(err),
        });
      }
    }
  }

  tenantCoordinators.forEach((coordinator) => {
    coordinator.handleTwilioStatusCallback(callSid, callStatus);
  });

  const terminalStatuses = ['completed', 'busy', 'no-answer', 'canceled', 'failed'];
  if (terminalStatuses.includes(callStatus)) {
    for (const [visitorIp, entry] of activeDemoCalls) {
      if (entry.callSid === callSid) {
        activeDemoCalls.delete(visitorIp);
        const eventType = callStatus === 'completed' ? 'call_completed' : 'call_abandoned';
        recordDemoAnalyticsEvent(eventType, entry.ipHash, entry.agentType, callDuration).catch(() => {});

        try {
          const pool = getPlatformPool();
          const { rows } = await pool.query(
            `SELECT id FROM call_sessions WHERE tenant_id = $1 AND call_sid = $2 LIMIT 1`,
            [DEMO_TENANT_ID, callSid],
          );
          if (rows.length > 0) {
            scheduleDemoDataCleanup(rows[0].id as string);
          }
        } catch (err) {
          logger.warn('Failed to schedule demo data cleanup', { callSid, error: String(err) });
        }
        break;
      }
    }
  }

  const mapping = mapTwilioTerminalStatus(callStatus);
  if (mapping) {
    try {
      const resolved = await resolveContactByCallSid(callSid);
      if (resolved) {
        await updateContactStatus(
          resolved.tenantId,
          resolved.contactId,
          mapping.status,
          callSid,
          `Twilio status: ${callStatus}`,
          mapping.outcome,
        );
        await checkCampaignCompletion(resolved.tenantId, resolved.campaignId);
        logger.info('Campaign contact updated from status callback', {
          callSid,
          contactId: resolved.contactId,
          status: mapping.status,
        });
      }
    } catch (err) {
      logger.warn('Failed to update campaign contact from status callback', {
        callSid,
        error: String(err),
      });
    }
  }

  res.sendStatus(204);
});

router.post('/twilio/outbound', async (req: Request, res: Response) => {
  const tenantId = (req.body.tenantId ?? req.query.tenantId) as string;
  const agentId = (req.body.agentId ?? req.query.agentId) as string;
  const campaignId = (req.body.campaignId ?? req.query.campaignId) as string;
  const contactId = (req.body.contactId ?? req.query.contactId) as string;
  const callSid = (req.body.CallSid ?? req.query.CallSid ?? '') as string;

  if (!tenantId || !agentId) {
    res.status(400).type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    );
    return;
  }

  if (await checkTenantSuspended(tenantId)) {
    logger.warn('Outbound call blocked — tenant suspended', { tenantId, callSid });
    if (contactId) {
      updateContactStatus(tenantId, contactId, 'failed', callSid, 'Account suspended', 'failed').catch(() => {});
    }
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    );
    return;
  }

  try {
    const pool = (await import('../../../platform/db')).getPlatformPool();
    const { rows: phoneRows } = await pool.query(
      `SELECT phone_verified FROM users WHERE tenant_id = $1 AND role = 'admin' ORDER BY created_at ASC LIMIT 1`,
      [tenantId],
    );
    if (phoneRows.length > 0 && !(phoneRows[0].phone_verified as boolean)) {
      logger.warn('Outbound call blocked — phone not verified', { tenantId, callSid });
      if (contactId) {
        updateContactStatus(tenantId, contactId, 'failed', callSid, 'Phone not verified', 'failed').catch(() => {});
      }
      res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      );
      return;
    }
  } catch (err) {
    logger.error('Phone verification check failed — allowing call', { tenantId, error: String(err) });
  }

  const plan = await resolveTenantPlan(tenantId);

  const hourlyCheck = checkHourlyCallLimit(tenantId, plan);
  if (!hourlyCheck.allowed) {
    logger.warn('Outbound call blocked by hourly rate limit', { tenantId, callSid, reason: hourlyCheck.reason });
    if (contactId) {
      updateContactStatus(tenantId, contactId, 'failed', callSid, 'Hourly rate limit exceeded', 'failed').catch(() => {});
    }
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    );
    return;
  }

  const dailyCheck = await checkDailyMinuteCap(tenantId, plan);
  if (!dailyCheck.allowed) {
    logger.warn('Outbound call blocked by daily minute cap', { tenantId, callSid, reason: dailyCheck.reason });
    if (contactId) {
      updateContactStatus(tenantId, contactId, 'failed', callSid, 'Daily minute cap exceeded', 'failed').catch(() => {});
    }
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    );
    return;
  }

  const budgetResult = await checkBudget(tenantId);
  if (!budgetResult.allowed) {
    logger.warn('Outbound call blocked by subscription budget', {
      tenantId,
      reason: budgetResult.reason,
      plan: budgetResult.plan,
      usage: budgetResult.usage,
    });
    if (contactId) {
      updateContactStatus(tenantId, contactId, 'failed', callSid, 'Budget exceeded', 'failed').catch(() => {});
    }
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    );
    return;
  }

  incrementHourlyCallCount(tenantId);

  const answeredBy = (req.body.AnsweredBy ?? req.query.AnsweredBy ?? '') as string;

  if (answeredBy && (answeredBy.startsWith('machine') || answeredBy === 'fax')) {
    logger.info('AMD: answering machine detected', { campaignId, contactId, answeredBy });

    let voicemailMessage: string | undefined;
    if (tenantId && agentId) {
      try {
        const agentRow = await getAgentConfig(tenantId, agentId);
        voicemailMessage = (agentRow?.metadata as Record<string, unknown> | undefined)?.voicemailMessage as string | undefined;
      } catch {
        // fall through to default behavior
      }
    }

    if (tenantId && contactId) {
      const outcome = classifyCallOutcome({
        answeredBy,
        callDurationSeconds: 0,
        streamEstablished: false,
      });
      updateContactStatus(tenantId, contactId, 'voicemail', callSid, answeredBy, outcome).catch(() => {});

      if (campaignId) {
        getCampaign(tenantId, campaignId).then((campaign) => {
          if (campaign && campaign.type && campaign.type !== 'outbound_call') {
            updateContactTypeDisposition(tenantId!, campaignId!, contactId!, 'no_response').catch(() => {});
          }
        }).catch(() => {});
      }
    }

    if (voicemailMessage && (answeredBy === 'machine_end_other' || answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence')) {
      logger.info('Leaving voicemail message', { campaignId, contactId });
      res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${voicemailMessage.replace(/[<>&"']/g, '')}</Say>
  <Hangup/>
</Response>`,
      );
    } else {
      logger.info('Voicemail detected — hanging up (no message configured or beep not detected)', { campaignId, contactId });
      res.type('text/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      );
    }
    return;
  }

  const wsProtocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3001';
  const streamToken = process.env.VOICE_GATEWAY_STREAM_TOKEN;
  const tokenParam = streamToken ? `?token=${encodeURIComponent(streamToken)}` : '';
  const wsUrl = `${wsProtocol}://${host}/twilio/stream${tokenParam}`;

  logger.info('Outbound call connected — starting stream', {
    tenantId,
    agentId,
    campaignId,
    contactId,
    callSid,
  });

  const campaignParams = campaignId
    ? `      <Parameter name="campaignId" value="${campaignId}" />
      <Parameter name="contactId" value="${contactId ?? ''}" />`
    : '';

  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="tenantId" value="${tenantId}" />
      <Parameter name="agentId" value="${agentId}" />
      <Parameter name="agentType" value="outbound" />
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="callerNumber" value="${req.body.To ?? req.query.To ?? ''}" />
      <Parameter name="calledNumber" value="${req.body.From ?? req.query.From ?? ''}" />
${campaignParams}
    </Stream>
  </Connect>
</Response>`,
  );
});

router.post('/twilio/sms', async (req: Request, res: Response) => {
  const body = (req.body.Body ?? '') as string;
  const from = (req.body.From ?? '') as string;
  const to = (req.body.To ?? '') as string;
  const messageSid = (req.body.MessageSid ?? '') as string;

  logger.info('Inbound SMS received', { from: redactPHI(from), to: redactPHI(to) });

  let twimlResponse = '';

  try {
    const routing = await lookupByPhoneNumber(to);
    if (!routing) {
      logger.warn('No routing found for inbound SMS', { to: redactPHI(to) });
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
    }

    const { tenantId, phoneNumberId } = routing;
    const SmsService = await import('../../../platform/sms/SmsConversationService');

    const trimmedBody = body.trim().toLowerCase();
    const isOptOut = isSmsOptOut(body);
    const isHelp = trimmedBody === 'help' || trimmedBody === 'info';

    if (isOptOut) {
      await addToDnc(tenantId, from, 'sms', `SMS opt-out: "${body.trim()}"`);
      await SmsService.logConsent(tenantId, from, 'opt_out', body.trim(), 'inbound_sms', messageSid || undefined);
      logger.info('SMS opt-out processed — added to DNC', { tenantId, phone: redactPHI(from) });
    }

    if (isHelp) {
      await SmsService.logConsent(tenantId, from, 'help_request', body.trim(), 'inbound_sms', messageSid || undefined);
    }

    const conversation = await SmsService.getOrCreateConversation(tenantId, phoneNumberId, from);

    await SmsService.saveMessage(tenantId, conversation.id, {
      direction: 'inbound',
      fromNumber: from,
      toNumber: to,
      body,
      status: 'received',
      twilioSid: messageSid || undefined,
    });

    await SmsService.logActivity(tenantId, conversation.id, 'message_received', null, null, { from });

    const autoReply = await SmsService.evaluateAutoReplies(tenantId, body, phoneNumberId);
    if (autoReply && !isOptOut) {
      twimlResponse = `<Message>${autoReply.replace(/[<>&]/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;')}</Message>`;

      await SmsService.saveMessage(tenantId, conversation.id, {
        direction: 'outbound',
        fromNumber: to,
        toNumber: from,
        body: autoReply,
        status: 'sent',
      });
    }

    if (!conversation.assigneeUserId) {
      const assignment = await SmsService.evaluateAssignmentRules(tenantId, conversation, body);
      if (assignment) {
        await SmsService.updateConversation(tenantId, conversation.id, {
          assigneeUserId: assignment.userId,
          assigneeTeam: assignment.team,
        });
        await SmsService.logActivity(tenantId, conversation.id, 'assigned', null, null, {
          team: assignment.team,
          user: assignment.userId,
        });
      }
    }
  } catch (err) {
    logger.error('Failed to process inbound SMS', { error: String(err), from: redactPHI(from) });
  }

  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${twimlResponse}</Response>`,
  );
});

export default router;
export { getCoordinator, tenantCoordinators };
