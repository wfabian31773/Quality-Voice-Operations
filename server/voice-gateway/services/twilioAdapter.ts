import { createLogger } from '../../../platform/core/logger';
import { redactPHI } from '../../../platform/core/phi/redact';
import type { TwilioTransferAdapter } from './escalation';

const logger = createLogger('TWILIO_ADAPTER');

export class PlatformTwilioAdapter implements TwilioTransferAdapter {
  private accountSid: string;
  private authToken: string;

  constructor(config: {
    accountSid: string;
    authToken: string;
  }) {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;

    logger.info('Twilio adapter initialized', {
      accountSid: config.accountSid ? `${config.accountSid.slice(0, 6)}...` : 'not set',
    });
  }

  async terminateCall(callSid: string): Promise<{ success: boolean; error?: string }> {
    logger.info('Terminating call via Twilio API', { callSid });

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${callSid}.json`;
      const body = new URLSearchParams({ Status: 'completed' });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Twilio terminate API error', { callSid, status: response.status, error: errorText });
        return { success: false, error: `Twilio API error: ${response.status}` };
      }

      logger.info('Call terminated successfully via Twilio', { callSid });
      return { success: true };
    } catch (err) {
      logger.error('Twilio terminate request failed', { callSid, error: String(err) });
      return { success: false, error: String(err) };
    }
  }

  async initiateTransfer(callSid: string, toNumber: string): Promise<{ success: boolean; error?: string }> {
    logger.info('Initiating call transfer', {
      callSid,
      targetNumber: redactPHI(toNumber),
    });

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${callSid}.json`;
      const body = new URLSearchParams({
        Twiml: `<Response><Dial>${toNumber}</Dial></Response>`,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Twilio transfer API error', { callSid, status: response.status, error: errorText });
        return { success: false, error: `Twilio API error: ${response.status}` };
      }

      logger.info('Call transfer initiated successfully', { callSid });
      return { success: true };
    } catch (err) {
      logger.error('Twilio transfer request failed', { callSid, error: String(err) });
      return { success: false, error: String(err) };
    }
  }
}

export function createTwilioAdapterFromEnv(): PlatformTwilioAdapter | undefined {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    logger.warn('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set — escalation transfers disabled');
    return undefined;
  }

  return new PlatformTwilioAdapter({
    accountSid,
    authToken,
  });
}
