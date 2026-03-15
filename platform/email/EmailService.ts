import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { createLogger } from '../core/logger';

const logger = createLogger('EMAIL_SERVICE');

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
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

  const mailOptions = {
    from: FROM_ADDRESS,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  };

  try {
    if (useConsole) {
      const info = await transport.sendMail(mailOptions);
      const parsed = JSON.parse(info.message);
      logger.info('Email (console mode)', {
        to: parsed.to,
        subject: parsed.subject,
      });
      logger.debug('Email body preview', { html: message.html.substring(0, 500) });
      return { success: true, messageId: info.messageId };
    }

    const info = await transport.sendMail(mailOptions);
    logger.info('Email sent', { to: message.to, messageId: info.messageId });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Failed to send email', { to: message.to, error });
    return { success: false, error };
  }
}
