---
name: Proxied Twilio signature URL
description: When Twilio webhooks are reverse-proxied under a path prefix that gets stripped before reaching the handler, signature validation must reconstruct the externally-signed URL, not the internal rewritten one.
---

# Rule
When you put a reverse proxy in front of voice-gateway (or any Twilio webhook handler) that **rewrites** the request path (e.g. strips a `/vg` mount prefix), the signature middleware MUST reconstruct the full URL Twilio signed — i.e. include the stripped prefix — before calling `twilio.validateRequest`.

**Why:** Twilio's `validateRequest(authToken, signature, url, params)` HMACs the **exact URL configured in the Twilio console**. If the request was POSTed to `https://host/vg/twilio/voice` but `req.originalUrl` inside the handler is just `/twilio/voice` (because the proxy stripped the mount), recomputing the HMAC against `https://host/twilio/voice` will not match the signature header and every legitimate webhook 403s with `invalid_signature`. The failure mode looks identical to "Twilio is misconfigured" and is easy to misdiagnose — the 4-file proxy fix that originally restored call routing turned the prior 404s into 403s until this was patched.

**How to apply:** Have the proxy inject an `x-forwarded-prefix` header carrying the stripped mount (`/vg` here, but generalize). In the signature middleware, prepend that header to `req.originalUrl` when building the URL passed to `validateRequest`. Default to empty string if absent so direct (non-proxied) hits still verify correctly. The same rule applies to any other webhook signer that binds the URL (Stripe binds the body, not the URL — different story).

**Companion gotcha — `x-forwarded-*` headers can be comma-joined:** When more than one proxy sits on the request path (Replit edge, then your own `http-proxy-middleware` with `xfwd: true`), each one appends its value to the existing header. Express exposes the result as a single comma-joined string (e.g. `x-forwarded-proto: 'https,http'`). Always `split(',')[0].trim()` every forwarded header before using it — the externally-visible value is always the first one. Applies to `x-forwarded-proto`, `x-forwarded-host`, `x-forwarded-for`, and any custom forwarded headers you inject.

This bug has **two distinct surfaces** in any Twilio webhook stack — fix both in the same pass or you'll get a confusing "second outage" after the first fix lands:

1. *Signature validation* — feeding the comma-joined value into `new URL(...)` throws `TypeError: Invalid URL`, the middleware fails closed with 500, Twilio plays "an application error has occurred" to the caller.
2. *TwiML `<Stream url>` construction* — a strict `proto === 'https' ? 'wss' : 'ws'` falls through to `ws://` on `'https,http'`. Twilio refuses non-TLS Media Streams in production, ends the call immediately, and the status callback reports `no-answer` ~1.4 s later (looks indistinguishable from an unreachable agent).

Centralize the parsing in a single helper (`firstForwarded(h)` + a `resolveForwardedWsTarget(req)` wrapper that also handles default host) and route both surfaces through it.
