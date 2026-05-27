import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { recordRejection } from './twilioSignatureMetrics';
import { deriveNonce, isReplay } from './twilioReplayCache';

const logger = createLogger('TWILIO_SIGNATURE');

let validateRequestFn: ((authToken: string, signature: string, url: string, params: Record<string, string>) => boolean) | undefined;

try {
  const twilio = require('twilio');
  validateRequestFn = twilio.validateRequest;
} catch {
  logger.warn('Twilio SDK not available — signature validation will fail-closed in production');
}

function isDevEnv(): boolean {
  const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase();
  return !appEnv.startsWith('prod') && appEnv !== 'staging';
}

export function twilioSignatureMiddleware(req: Request, res: Response, next: NextFunction): void {
  void runTwilioSignatureCheck(req, res, next);
}

async function runTwilioSignatureCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!authToken || !validateRequestFn) {
    if (isDevEnv()) {
      logger.debug('Twilio signature validation skipped (dev mode, missing auth token or SDK)');
      next();
      return;
    }
    logger.error('Twilio signature validation unavailable in production — rejecting request', {
      path: req.path,
      hasAuthToken: !!authToken,
      hasValidator: !!validateRequestFn,
    });
    recordRejection('validator_unavailable');
    res.status(503).send('Service Unavailable');
    return;
  }

  const signature = req.headers['x-twilio-signature'] as string;
  if (!signature) {
    logger.warn('Missing X-Twilio-Signature header', {
      path: req.path,
      remoteAddress: req.ip,
    });
    recordRejection('missing_header');
    res.status(403).send('Forbidden');
    return;
  }

  // Forwarded headers can arrive comma-joined when multiple proxies
  // each append their own value (e.g. Replit's edge sets
  // `x-forwarded-proto: https`, then http-proxy-middleware's `xfwd:true`
  // appends `http` for the internal admin-api → voice-gateway hop, so
  // Express exposes `x-forwarded-proto: 'https,http'`). The Twilio
  // signature URL must be the externally-visible one, which is always
  // the FIRST value. Same for host. Same defensive split applied to
  // `x-forwarded-prefix` even though we only inject it ourselves.
  const firstForwarded = (h: string | string[] | undefined): string => {
    if (!h) return '';
    const raw = Array.isArray(h) ? h[0] : h;
    return (raw.split(',')[0] ?? '').trim();
  };
  const protocol = firstForwarded(req.headers['x-forwarded-proto']) || req.protocol;
  const host = firstForwarded(req.headers['x-forwarded-host']) || (req.headers.host ?? '');
  // When admin-api proxies us at `/vg/*` (production), it strips the
  // `/vg` prefix before forwarding, so `req.originalUrl` here is the
  // already-rewritten internal path (e.g. `/twilio/voice`). Twilio
  // signed the public URL (`https://host/vg/twilio/voice`), so we must
  // re-prepend the original prefix before verifying the signature.
  const forwardedPrefix = firstForwarded(req.headers['x-forwarded-prefix']);
  const fullUrl = `${protocol}://${host}${forwardedPrefix}${req.originalUrl}`;

  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const isValid = validateRequestFn(authToken, signature, fullUrl, params);

  if (!isValid) {
    logger.warn('Invalid Twilio signature', {
      path: req.path,
      remoteAddress: req.ip,
    });
    recordRejection('invalid_signature');
    res.status(403).send('Forbidden');
    return;
  }

  // Replay protection. Twilio's signature does not bind a timestamp, so a
  // captured payload re-played verbatim would still verify. Each Twilio
  // webhook carries a unique-per-event identifier (`MessageSid`,
  // `CallSid` + `SequenceNumber` on status callbacks); we treat that as a
  // one-shot nonce inside a short TTL window. See `twilioReplayCache.ts`
  // for the trade-offs around legitimate Twilio retries.
  // Route detection has to use the full mount path, not `req.path` — Express
  // strips the mount prefix from `req.path` inside a `app.use(<prefix>, mw)`
  // handler, so a middleware mounted at `/twilio/status` sees `req.path === '/'`
  // and would fall through to the generic nonce bucket (losing
  // `SequenceNumber`-based dedupe). `req.originalUrl` preserves the full
  // path-and-query as the client sent it.
  const routePath = req.originalUrl || `${req.baseUrl}${req.path}`;
  const nonce = deriveNonce(routePath, params as Record<string, unknown>);
  if (nonce) {
    // `isReplay` is now async + atomically claims the nonce in BOTH the
    // in-memory cache and the durable Postgres store, so an attacker can't
    // race the same captured payload across two gateway instances and have
    // both succeed.
    const replay = await isReplay(nonce);
    if (replay) {
      logger.warn('Twilio webhook rejected — replay detected', {
        path: routePath,
        // Don't log the raw SID at info level; the nonce prefix (`call:`,
        // `status:`, `sms:`) is enough for ops without leaking identifiers.
        nonceKind: nonce.split(':', 1)[0],
        remoteAddress: req.ip,
      });
      recordRejection('replay_detected');
      res.status(403).send('Forbidden');
      return;
    }
  }

  next();
}
