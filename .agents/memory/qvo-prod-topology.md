---
name: QVO prod topology
description: In QVO production deployments, only admin-api owns the public hostname; voice-gateway is on a private port. Twilio (HTTP + WSS) must reach it via a reverse proxy on admin-api.
---

# Rule
In QVO's production deploy (single `.replit.app` hostname mapping to admin-api on port 5000/80), the voice-gateway process listens only on a private port (default 3001) and is **not** reachable from the public internet directly. Anything Twilio-facing — webhook POSTs at `/twilio/*` and the `wss://…/twilio/stream` media socket — must be reverse-proxied through admin-api under a `/vg/*` mount (HTTP via `http-proxy-middleware`, WebSocket upgrades via `server.on('upgrade', proxy.upgrade)`).

**Why:** The Replit deployment exposes exactly one public port, and admin-api owns it because it also serves the SPA and the `/platform/*` API. Dev mode hides this asymmetry because Vite's dev-server proxy forwards `/twilio` (and now `/vg`) to localhost:3001 directly, so the breakage only shows up in prod as a hard 404 from the SPA fallback. Twilio console URLs **must** point at the `/vg/...` paths, and the TwiML `<Stream url>` the voice-gateway emits must also include the `/vg/` prefix so the WSS upgrade hits the proxy.

**How to apply:** When changing routing for any service that needs external reachability, first check whether it owns the public hostname or whether it depends on admin-api proxying it. If you're adding a new externally-reachable surface (new webhook, new WS), either (a) mount it on admin-api directly, or (b) extend the `/vg/*` proxy and remember to also update the dev Vite proxy + any signature middleware that depends on the original URL.
