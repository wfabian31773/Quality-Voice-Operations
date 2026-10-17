import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('TWILIO_SENDER');

export interface TwilioCredentials {
  accountSid: string;
  apiKey: string;
  apiKeySecret: string;
  phoneNumber: string;
}

export async function getTwilioCredentials(tenantId: string): Promise<TwilioCredentials | null> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT config FROM connectors WHERE tenant_id = $1 AND connector_type = 'sms' AND enabled = true LIMIT 1`,
      [tenantId],
    );
    if (rows.length > 0) {
      const config = rows[0].config as Record<string, unknown>;
      const creds = (config.credentials || config) as Record<string, string>;
      if (creds.account_sid && (creds.auth_token || creds.api_key_secret)) {
        return {
          accountSid: creds.account_sid,
          apiKey: creds.api_key || creds.account_sid,
          apiKeySecret: creds.api_key_secret || creds.auth_token,
          phoneNumber: creds.from_number || creds.phone_number || '',
        };
      }
    }
  } catch (err) {
    logger.warn('Failed to load tenant Twilio credentials from connectors', { tenantId, error: String(err) });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_OUTBOUND_NUMBER || '';

  if (accountSid && authToken) {
    return { accountSid, apiKey: accountSid, apiKeySecret: authToken, phoneNumber };
  }

  return null;
}

/** Non-2xx Twilio REST response. `twilioCode` is Twilio's numeric error code when the body had one. */
export class TwilioApiError extends Error {
  readonly httpStatus: number;
  readonly twilioCode: number | null;

  constructor(message: string, httpStatus: number, twilioCode: number | null) {
    super(message);
    this.name = 'TwilioApiError';
    this.httpStatus = httpStatus;
    this.twilioCode = twilioCode;
  }
}

export async function twilioPost(
  creds: TwilioCredentials,
  path: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}${path}`;
  const auth = Buffer.from(`${creds.apiKey}:${creds.apiKeySecret}`).toString('base64');
  const formBody = new URLSearchParams(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody.toString(),
  });
  if (!response.ok) {
    const errData = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new TwilioApiError(
      `Twilio API error: ${response.status} ${errData.message || response.statusText}`,
      response.status,
      typeof errData.code === 'number' ? errData.code : null,
    );
  }
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Raw Twilio Messages transport. Internal to the SMS chokepoint
 * (`platform/actions/sms/send.ts`, action `sms.send`): every other caller
 * must go through the chokepoint so opt-out, quiet hours, rate limits,
 * persistence and StatusCallback are applied.
 */
export async function sendTwilioSms(
  tenantId: string,
  toNumber: string,
  fromNumber: string,
  body: string,
  opts: { statusCallback?: string | null } = {},
): Promise<{ sid?: string; status?: string }> {
  const creds = await getTwilioCredentials(tenantId);
  if (!creds) {
    throw new Error('No Twilio credentials configured for tenant');
  }
  const form: Record<string, string> = {
    To: toNumber,
    From: fromNumber,
    Body: body,
  };
  if (opts.statusCallback) form.StatusCallback = opts.statusCallback;
  const result = await twilioPost(creds, '/Messages.json', form);
  return {
    sid: typeof result.sid === 'string' ? result.sid : undefined,
    status: typeof result.status === 'string' ? result.status : undefined,
  };
}
