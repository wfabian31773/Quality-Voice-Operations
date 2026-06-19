/**
 * Manual DevOps probe for the realtime voice-stream path.
 *
 *   npm run diagnose:realtime-stream                 # handshake check (default)
 *   npm run diagnose:realtime-stream -- --mode=full  # full time-to-first-audio
 *   npm run diagnose:realtime-stream -- --url=ws://host:3001/twilio/stream
 *
 * Env: VOICE_GATEWAY_STREAM_URL / VOICE_GATEWAY_HOST / VOICE_GATEWAY_PORT
 *      VOICE_GATEWAY_STREAM_TOKEN (if the gateway enforces a stream token)
 *
 * Exits 0 when the realtime path is healthy, 1 when the probe fails — so it
 * drops straight into a cron / CI / uptime check. Prints a human-readable
 * stage-by-stage diagnosis to stderr and the full JSON report to stdout.
 */
import { runRealtimeStreamDiagnostic, type StreamDiagnosticMode } from '../server/voice-gateway/services/streamDiagnostic';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = 'true';
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode: StreamDiagnosticMode = args.mode === 'full' ? 'full' : 'handshake';

  process.stderr.write(`\nRealtime stream diagnostic (mode=${mode})\n`);

  const report = await runRealtimeStreamDiagnostic({
    mode,
    url: args.url,
    token: args.token,
    firstAudioTimeoutMs: args['first-audio-timeout'] ? parseInt(args['first-audio-timeout'], 10) : undefined,
    handshakeGraceMs: args['handshake-grace'] ? parseInt(args['handshake-grace'], 10) : undefined,
  });

  process.stderr.write(`Target:        ${report.target}\n`);
  process.stderr.write(`Correlation:   ${report.correlationId}\n`);
  process.stderr.write(`Result:        ${report.ok ? 'PASS ✅' : 'FAIL ❌'}\n`);
  process.stderr.write('Stages:\n');
  for (const s of report.stages) {
    const lat = s.latencyMs !== undefined ? ` ${s.latencyMs}ms` : '';
    const detail = s.detail ? ` — ${s.detail}` : '';
    const icon = s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : '·';
    process.stderr.write(`  ${icon} ${s.stage}${lat}${detail}\n`);
  }
  if (!report.ok) {
    process.stderr.write(`\nFailed at: ${report.failureStage} (${report.failureReason})\n`);
    if (report.error) process.stderr.write(`Error:     ${report.error}\n`);
    process.stderr.write('\nDiagnosis hints:\n');
    process.stderr.write(hintFor(report.failureReason) + '\n');
  }
  process.stderr.write('\n');

  // Machine-readable report on stdout for piping into jq / dashboards.
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  process.exit(report.ok ? 0 : 1);
}

function hintFor(reason: string | undefined): string {
  switch (reason) {
    case 'connect_refused':
      return '  • Gateway not listening — check the process is up and VOICE_GATEWAY_PORT/HOST/URL.';
    case 'connect_timeout':
      return '  • Network path to the gateway is slow or blocked — check firewalls / load balancer.';
    case 'auth_rejected':
      return '  • Stream token rejected — set --token / VOICE_GATEWAY_STREAM_TOKEN to match the gateway.';
    case 'bad_handshake':
      return '  • Non-101 upgrade response — a proxy/LB may be stripping the WebSocket upgrade.';
    case 'closed_early':
      return '  • Gateway closed the socket right after `start` — check required stream params and logs.';
    case 'setup_error':
      return '  • Session setup failed — inspect WS_STREAM logs for agent load / OpenAI connect errors.';
    case 'first_audio_timeout':
      return '  • No audio returned in time — check OPENAI_API_KEY, the seeded diagnostic agent, and provider latency.';
    default:
      return '  • Inspect the WS_STREAM and STREAM_DIAGNOSTIC logs for the correlation id above.';
  }
}

main().catch((err) => {
  process.stderr.write(`Diagnostic crashed: ${String(err)}\n`);
  process.exit(2);
});
