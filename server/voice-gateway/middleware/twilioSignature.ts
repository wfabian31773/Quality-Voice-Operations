import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('TWILIO_SIGNATURE');

let validateRequestFn: ((authToken: string, signature: string, url: string, params: Record<string, string>) => boolean) | undefined;

try {
  const twilio = require('twilio');
  validateRequestFn = twilio.validateRequest;
} catch {
  logger.warn('Twilio SDK not available — signature validation will fail-closed in production');
}

const isDev = process.env.NODE_ENV !== 'production';

export function twilioSignatureMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!authToken || !validateRequestFn) {
    if (isDev) {
      logger.debug('Twilio signature validation skipped (dev mode, missing auth token or SDK)');
      next();
      return;
    }
    logger.error('Twilio signature validation unavailable in production — rejecting request', {
      path: req.path,
      hasAuthToken: !!authToken,
      hasValidator: !!validateRequestFn,
    });
    res.status(503).send('Service Unavailable');
    return;
  }

  const signature = req.headers['x-twilio-signature'] as string;
  if (!signature) {
    logger.warn('Missing X-Twilio-Signature header', {
      path: req.path,
      remoteAddress: req.ip,
    });
    res.status(403).send('Forbidden');
    return;
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const fullUrl = `${protocol}://${host}${req.originalUrl}`;

  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const isValid = validateRequestFn(authToken, signature, fullUrl, params);

  if (!isValid) {
    logger.warn('Invalid Twilio signature', {
      path: req.path,
      remoteAddress: req.ip,
    });
    res.status(403).send('Forbidden');
    return;
  }

  next();
}
