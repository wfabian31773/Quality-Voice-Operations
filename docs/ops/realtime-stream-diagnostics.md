# Realtime stream diagnostics & telemetry

A built-in, always-available way to **test and diagnose the realtime voice
path** (Twilio Media Streams ↔ OpenAI Realtime) without placing a real phone
call, plus continuous telemetry on the numbers that matter: per-stage latency
and failures.

## What it covers

The realtime path is: Twilio opens a WebSocket to the gateway
(`/twilio/stream`) → sends a `start` frame → the gateway loads the agent and
opens an OpenAI Realtime session → audio streams both ways. The diagnostic
drives that exact path as a synthetic Twilio client and times each stage:

| stage           | meaning                                              |
| --------------- | ---------------------------------------------------- |
| `ws_connect`    | TCP + WebSocket upgrade + stream-token auth          |
| `session_setup` | gateway accepted `start` and built the realtime session |
| `first_audio`   | time until the agent's first audio frame comes back  |
| `total`         | end-to-end probe duration                            |

## Run it manually (CLI)

```bash
# Handshake check — verifies connectivity, auth, and start-frame handling.
# Safe anywhere; no seeded agent or OpenAI key required.
npm run diagnose:realtime-stream

# Full check — also waits for first audio (needs a reachable gateway with a
# seeded diagnostic agent + OPENAI_API_KEY).
npm run diagnose:realtime-stream -- --mode=full

# Point at a specific gateway / pass the stream token:
npm run diagnose:realtime-stream -- --url=ws://gateway:3001/twilio/stream --token=$VOICE_GATEWAY_STREAM_TOKEN
```

Exit code is **0 when healthy, 1 when the path is broken** (2 on a crash), so it
drops straight into cron / CI / an uptime check. A human-readable stage
breakdown with diagnosis hints goes to **stderr**; the full JSON report goes to
**stdout** (pipe into `jq`).

Env: `VOICE_GATEWAY_STREAM_URL` (or `VOICE_GATEWAY_HOST` / `VOICE_GATEWAY_PORT`),
`VOICE_GATEWAY_STREAM_TOKEN`.

## Run it over HTTP (ops endpoint)

Gated by `x-admin-token: $ADMIN_INTERNAL_TOKEN` (same as the other gateway admin
routes).

```bash
# Run a probe on demand. Returns 200 when healthy, 503 when the path is broken
# — so an external uptime monitor can treat it as a realtime-path health gate.
curl -X POST https://gateway/admin/diagnostics/realtime-stream \
  -H "x-admin-token: $ADMIN_INTERNAL_TOKEN" \
  -H 'content-type: application/json' -d '{"mode":"handshake"}'

# Latency / failure telemetry snapshot.
curl https://gateway/admin/diagnostics/realtime-stream/metrics \
  -H "x-admin-token: $ADMIN_INTERNAL_TOKEN"
```

## Telemetry

`realtimeStreamMetrics` records every attempt — both synthetic probes
(`source: 'probe'`) and **real production sessions** (`source: 'live'`, fed from
`stream.ts`) — into one rolling-window snapshot exposed at the metrics endpoint
above. It includes:

- per-stage latency: count, avg, **p50 / p95 / max**
- success / failure totals + success rate, failures **by stage and reason**
- `failureRatePerMinute` and the p95 thresholds used for alerting

It auto-alerts (via the shared `logError` critical/warning channel, with a 5‑min
cooldown) on a **failure spike** (≥5/min) or when a stage **p95 latency** breaches
its ceiling (`first_audio` 8s, `total` 12s, …). The module holds no PII — only
timings, counts, and short reason codes.

## Logs

Every probe run is tagged with a short `correlationId` and logs each stage
(`STREAM_DIAGNOSTIC`). The gateway's own `WS_STREAM` logs share the call's
`callId`/`callSid`, and the live path now logs `sessionSetupMs` /
`firstAudioMs`, so a single id stitches the probe, the gateway, and the
telemetry together when diagnosing an incident.

## Tests

- `platform/core/observability/realtimeStreamMetrics.test.ts` — telemetry unit tests
- `server/voice-gateway/services/streamDiagnostic.test.ts` — probe protocol/timing against a stub gateway
- `server/voice-gateway/routes/diagnostics.test.ts` — endpoint auth + status mapping
- `server/voice-gateway/routes/stream.diagnostic.integration.test.ts` — probe against the **real** `attachWebSocket` (auth rejection + start-frame validation)
