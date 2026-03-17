import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('ADMIN_SMS_INBOX');

interface TwilioCredentials {
  accountSid: string;
  apiKey: string;
  apiKeySecret: string;
  phoneNumber: string;
}

async function getTwilioCredentials(tenantId: string): Promise<TwilioCredentials | null> {
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

async function twilioFetch(creds: TwilioCredentials, path: string): Promise<Record<string, unknown>> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}${path}`;
  const auth = Buffer.from(`${creds.apiKey}:${creds.apiKeySecret}`).toString('base64');
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) {
    throw new Error(`Twilio API error: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

async function twilioPost(creds: TwilioCredentials, path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
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
    const errData = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Twilio API error: ${response.status} ${errData.message || response.statusText}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

interface TwilioMessage {
  sid: string;
  direction: string;
  from: string;
  to: string;
  body: string;
  date_sent: string;
  status: string;
}

const listConversationsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();

  try {
    const { rows: phoneNumbers } = await pool.query(
      `SELECT id, phone_number, friendly_name FROM phone_numbers WHERE tenant_id = $1`,
      [tenantId],
    );

    const conversations = phoneNumbers.map((pn: Record<string, unknown>) => ({
      phoneNumberId: pn.id,
      phoneNumber: pn.phone_number,
      friendlyName: pn.friendly_name,
    }));

    return res.json({ conversations, total: conversations.length });
  } catch (err) {
    logger.error('Failed to list SMS conversations', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list conversations' });
  }
};

const getMessagesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { phoneNumberId } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows: pnRows } = await pool.query(
      `SELECT phone_number FROM phone_numbers WHERE id = $1 AND tenant_id = $2`,
      [phoneNumberId, tenantId],
    );

    if (pnRows.length === 0) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    const phoneNumber = pnRows[0].phone_number as string;
    const creds = await getTwilioCredentials(tenantId);

    if (!creds) {
      logger.warn('No Twilio credentials available', { tenantId });
      return res.json({ messages: [], phoneNumber, threads: [] });
    }

    const [sentData, receivedData] = await Promise.all([
      twilioFetch(creds, `/Messages.json?From=${encodeURIComponent(phoneNumber)}&PageSize=50`),
      twilioFetch(creds, `/Messages.json?To=${encodeURIComponent(phoneNumber)}&PageSize=50`),
    ]);

    const sentMessages = ((sentData.messages || []) as TwilioMessage[]).map(m => ({
      id: m.sid,
      direction: 'outbound' as const,
      from: m.from,
      to: m.to,
      body: m.body,
      timestamp: m.date_sent,
      status: m.status,
    }));

    const receivedMessages = ((receivedData.messages || []) as TwilioMessage[]).map(m => ({
      id: m.sid,
      direction: 'inbound' as const,
      from: m.from,
      to: m.to,
      body: m.body,
      timestamp: m.date_sent,
      status: m.status,
    }));

    const allMessages = [...sentMessages, ...receivedMessages]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const threadMap = new Map<string, typeof allMessages>();
    for (const msg of allMessages) {
      const remoteNumber = msg.direction === 'inbound' ? msg.from : msg.to;
      if (!threadMap.has(remoteNumber)) {
        threadMap.set(remoteNumber, []);
      }
      threadMap.get(remoteNumber)!.push(msg);
    }

    const threads = Array.from(threadMap.entries()).map(([remoteNumber, msgs]) => ({
      remoteNumber,
      messages: msgs,
      lastMessage: msgs[msgs.length - 1],
      messageCount: msgs.length,
    }));

    threads.sort((a, b) =>
      new Date(b.lastMessage.timestamp).getTime() - new Date(a.lastMessage.timestamp).getTime()
    );

    return res.json({ messages: allMessages, phoneNumber, threads });
  } catch (err) {
    logger.error('Failed to get SMS messages', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get messages' });
  }
};

const sendMessageHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { phoneNumberId } = req.params;
  const { to, body } = req.body;

  if (!to || !body) {
    return res.status(400).json({ error: 'to and body are required' });
  }

  const pool = getPlatformPool();

  try {
    const { rows: pnRows } = await pool.query(
      `SELECT phone_number FROM phone_numbers WHERE id = $1 AND tenant_id = $2`,
      [phoneNumberId, tenantId],
    );

    if (pnRows.length === 0) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    const fromNumber = pnRows[0].phone_number as string;
    const creds = await getTwilioCredentials(tenantId);

    if (!creds) {
      return res.status(503).json({ error: 'SMS service not configured. Please set up Twilio credentials.' });
    }

    const twilioResponse = await twilioPost(creds, '/Messages.json', {
      To: to,
      From: fromNumber,
      Body: body,
    });

    const message = {
      id: twilioResponse.sid as string,
      direction: 'outbound',
      from: fromNumber,
      to,
      body,
      timestamp: new Date().toISOString(),
      status: twilioResponse.status as string || 'queued',
    };

    logger.info('SMS message sent via Twilio', { tenantId, to, messagesSid: twilioResponse.sid });
    return res.json({ message });
  } catch (err) {
    logger.error('Failed to send SMS', { tenantId, error: String(err) });
    return res.status(500).json({ error: `Failed to send message: ${err instanceof Error ? err.message : 'Unknown error'}` });
  }
};

const aiDraftHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { context } = req.body;

  try {
    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_ADMIN_API_KEY;
    if (!apiKey) {
      return res.json({ draft: 'Thank you for reaching out! I\'d be happy to help you with that. Let me check and get back to you shortly.' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful business assistant drafting SMS replies. Keep responses concise, professional, and friendly. Reply with just the message text, no quotation marks or labels.',
          },
          {
            role: 'user',
            content: `Based on this SMS conversation thread, draft a professional reply:\n\n${context || 'No conversation context provided.'}`,
          },
        ],
        max_tokens: 200,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message: { content: string } }>;
    const draft = choices?.[0]?.message?.content?.trim() || 'Thank you for reaching out! I\'d be happy to help you with that.';

    return res.json({ draft });
  } catch (err) {
    logger.error('Failed to generate AI draft', { tenantId, error: String(err) });
    return res.json({ draft: 'Thank you for reaching out! I\'d be happy to help you with that. Let me check and get back to you shortly.' });
  }
};

router.get('/sms-inbox/conversations', requireAuth, listConversationsHandler);
router.get('/sms-inbox/conversations/:phoneNumberId/messages', requireAuth, getMessagesHandler);
router.post('/sms-inbox/conversations/:phoneNumberId/send', requireAuth, requireMiniSystemWrite, sendMessageHandler);
router.post('/sms-inbox/ai-draft', requireAuth, aiDraftHandler);

export default router;
