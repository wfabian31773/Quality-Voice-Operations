import nodemailer from 'nodemailer';
import type { Transporter, SendMailOptions } from 'nodemailer';
import { createLogger } from '../core/logger';
import { isPermanentSmtpError } from './smtpErrorClass';

const logger = createLogger('EMAIL_SERVICE');

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /**
   * True when the underlying SMTP failure is terminal (5xx, address rejected,
   * mailbox full, …) and we should NOT auto-retry. Undefined / false means
   * either the send succeeded or the failure looks transient. Surfaced here
   * (instead of forcing every caller to re-parse `error`) so the support
   * reply auto-retry scheduler can short-circuit cleanly.
   */
  permanent?: boolean;
  responseCode?: number;
  smtpCode?: string;
}

let transporter: Transporter | null = null;
let useConsole = false;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    useConsole = true;
    logger.info('SMTP not configured — emails will be logged to console');
    transporter = nodemailer.createTransport({ jsonTransport: true });
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  logger.info('SMTP transport configured', { host, port });
  return transporter;
}

const FROM_ADDRESS = process.env.EMAIL_FROM ?? 'noreply@qualityvoiceops.com';

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const transport = getTransporter();

  const mailOptions: SendMailOptions = {
    from: FROM_ADDRESS,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (message.replyTo) mailOptions.replyTo = message.replyTo;
  if (message.headers) mailOptions.headers = message.headers;

  try {
    if (useConsole) {
      const info = await transport.sendMail(mailOptions);
      const parsed = JSON.parse(info.message);
      logger.info('Email (console mode)', {
        to: parsed.to,
        subject: parsed.subject,
      });
      logger.debug('Email body preview', { html: message.html.substring(0, 500) });
      // Deliberately omit messageId in console/jsonTransport mode so
      // callers don't persist a fake id no real provider will ever
      // confirm (would otherwise leave email rows in indefinite "live"
      // polling because no webhook event can match the synthetic id).
      return { success: true };
    }

    const info = await transport.sendMail(mailOptions);
    logger.info('Email sent', { to: message.to, messageId: info.messageId });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    const baseMessage = err instanceof Error ? err.message : String(err);
    // Nodemailer attaches structured fields to its errors. Pull them out so
    // callers (notably the auto-retry scheduler) can decide whether the
    // failure is worth retrying without re-parsing the message text.
    const e = err as Record<string, unknown> | null;
    const responseCode =
      e && typeof e.responseCode === 'number' ? (e.responseCode as number) : undefined;
    const smtpCode = e && typeof e.code === 'string' ? (e.code as string) : undefined;
    const response = e && typeof e.response === 'string' ? (e.response as string) : undefined;
    // Combine the human-readable message with the raw server response so
    // downstream classification has the most signal possible.
    const error = response && !baseMessage.includes(response)
      ? `${baseMessage} | ${response}`
      : baseMessage;
    const permanent =
      (responseCode !== undefined && responseCode >= 500 && responseCode < 600) ||
      isPermanentSmtpError(error) ||
      isPermanentSmtpError(smtpCode ?? null);
    logger.error('Failed to send email', { to: message.to, error, responseCode, smtpCode, permanent });
    return { success: false, error, permanent, responseCode, smtpCode };
  }
}
