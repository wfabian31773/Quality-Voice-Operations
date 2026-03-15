import { createRateLimiter } from './createRateLimiter';

/** 100 requests / minute per tenant+IP. */
export const apiRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 100,
  message: 'Too many API requests, please try again later.',
});

/** 10 attempts / 15 minutes per tenant+IP (login, token exchange). */
export const authRateLimiter = createRateLimiter({
  windowMs: 900_000,
  maxRequests: 10,
  message: 'Too many login attempts. Please try again in 15 minutes.',
});

/** 500 requests / minute per tenant+path+IP (Twilio webhooks). */
export const webhookRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 500,
  message: 'Too many webhook requests.',
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : req.socket?.remoteAddress ?? 'unknown';
    return `${req.path}:${ip}`;
  },
});
