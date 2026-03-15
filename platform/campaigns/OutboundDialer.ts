import { createLogger } from '../core/logger';
import { redactPHI } from '../core/phi/redact';
import { isOnDnc } from './DncService';
import { updateContactStatus } from './CampaignService';

const logger = createLogger('OUTBOUND_DIALER');

export interface DialParams {
  tenantId: string;
  campaignId: string;
  contactId: string;
  agentId: string;
  phoneNumber: string;
  callbackUrl: string;
  statusCallbackUrl: string;
}

export interface DialResult {
  success: boolean;
  callSid?: string;
  error?: string;
}

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_OUTBOUND_NUMBER;

  if (!accountSid || !authToken) {
    return null;
  }
  if (!fromNumber) {
    throw new Error('TWILIO_OUTBOUND_NUMBER is not set — required for outbound calls');
  }
  return { accountSid, authToken, fromNumber };
}

export async function dialContact(params: DialParams): Promise<DialResult> {
  const onDnc = await isOnDnc(params.tenantId, params.phoneNumber);
  if (onDnc) {
    logger.info('Dial blocked — number on DNC list', {
      tenantId: params.tenantId,
      campaignId: params.campaignId,
      contactId: params.contactId,
      phone: redactPHI(params.phoneNumber),
    });
    await updateContactStatus(params.tenantId, params.contactId, 'opted_out', undefined, 'DNC list match');
    return { success: false, error: 'DNC list match' };
  }

  const twilio = getTwilioClient();
  if (!twilio) {
    logger.warn('Twilio credentials not configured — cannot dial outbound calls', {
      tenantId: params.tenantId,
    });
    return { success: false, error: 'Twilio not configured' };
  }

  const twimlUrl = new URL(params.callbackUrl);
  twimlUrl.searchParams.set('tenantId', params.tenantId);
  twimlUrl.searchParams.set('agentId', params.agentId);
  twimlUrl.searchParams.set('campaignId', params.campaignId);
  twimlUrl.searchParams.set('contactId', params.contactId);

  logger.info('Dialing outbound contact', {
    tenantId: params.tenantId,
    campaignId: params.campaignId,
    contactId: params.contactId,
    phone: redactPHI(params.phoneNumber),
  });

  try {
    const body = new URLSearchParams({
      To: params.phoneNumber,
      From: twilio.fromNumber,
      Url: twimlUrl.toString(),
      StatusCallback: params.statusCallbackUrl,
      StatusCallbackMethod: 'POST',
      MachineDetection: 'DetectMessageEnd',
      MachineDetectionTimeout: '30',
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64')}`,
        },
        body: body.toString(),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Twilio call creation failed', {
        tenantId: params.tenantId,
        status: response.status,
        error: errorText,
      });
      return { success: false, error: `Twilio error ${response.status}: ${errorText}` };
    }

    const data = await response.json() as { sid?: string };
    logger.info('Outbound call initiated', {
      tenantId: params.tenantId,
      campaignId: params.campaignId,
      contactId: params.contactId,
      callSid: data.sid,
    });

    return { success: true, callSid: data.sid };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Failed to initiate outbound call', { tenantId: params.tenantId, error });
    return { success: false, error };
  }
}
