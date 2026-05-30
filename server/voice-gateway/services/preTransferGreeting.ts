/**
 * Pre-transfer greeting played by Twilio's TTS the instant a call is
 * answered, BEFORE the bidirectional <Connect><Stream> is established and
 * the OpenAI Realtime session finishes warming up.
 *
 * Why this exists: connecting the media stream and booting the realtime
 * session takes a beat. Without anything to fill that gap the caller hears
 * dead air and may hang up before the agent ever speaks. A short, premium
 * "Thank you for calling X, you'll now be transferred to Y" message makes
 * the wait feel intentional (a transfer) and covers the setup latency.
 *
 * The voice quality must not detract from the realtime agent, so we default
 * to one of Twilio's highest-quality neural voices and frame the message as
 * a transfer — a deliberate voice change into the agent then sounds natural.
 */

const DEFAULT_VOICE = 'Polly.Joanna-Neural';
const DEFAULT_LANGUAGE = 'en-US';
const DEMO_TENANT_ID = 'demo';
const DEMO_BRAND = 'Quality Voice Operations';

/** Escape a value for safe inclusion inside TwiML (XML) text/attributes. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isEnabled(): boolean {
  // Default ON for every agent. Set to "false"/"0"/"off" to disable globally.
  const raw = (process.env.TWILIO_PRETRANSFER_GREETING_ENABLED ?? 'true').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
}

function resolveVoice(): string {
  return (process.env.TWILIO_GREETING_VOICE ?? DEFAULT_VOICE).trim() || DEFAULT_VOICE;
}

function resolveLanguage(): string {
  return (process.env.TWILIO_GREETING_LANGUAGE ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;
}

/**
 * Resolve the business name spoken in the greeting. The demo tenant always
 * uses the QVO brand (the demo showcases QVO itself); real tenants use their
 * own tenant name. A global override is available via env.
 */
function resolveBusinessName(tenantId: string, tenantName: string | undefined): string | undefined {
  const override = (process.env.TWILIO_GREETING_BUSINESS_NAME ?? '').trim();
  if (override) return override;
  if (tenantId === DEMO_TENANT_ID) return DEMO_BRAND;
  const name = (tenantName ?? '').trim();
  return name.length > 0 ? name : undefined;
}

function buildGreetingText(businessName: string | undefined, agentName: string | undefined): string {
  const agent = (agentName ?? '').trim();
  const transferClause = agent.length > 0
    ? `You will now be transferred to ${agent}.`
    : 'You will now be connected to your assistant.';
  if (businessName && businessName.length > 0) {
    return `Thank you for calling ${businessName}. ${transferClause}`;
  }
  return `Thank you for calling. ${transferClause}`;
}

export interface PreTransferGreetingInput {
  tenantId: string;
  tenantName?: string;
  agentName?: string;
  agentMetadata?: Record<string, unknown> | null;
}

/**
 * Build the `<Say>` TwiML fragment for the pre-transfer greeting, or an
 * empty string when greetings are disabled. The returned string is already
 * XML-escaped and safe to inline before `<Connect>` in a TwiML response.
 *
 * A per-agent override is supported via `agentMetadata.preTransferGreeting`
 * (a non-empty string), letting individual agents customize the wording
 * (e.g. an after-hours line that mentions calling 911 for emergencies).
 */
export function buildPreTransferSayTwiml(input: PreTransferGreetingInput): string {
  if (!isEnabled()) return '';

  const override = typeof input.agentMetadata?.preTransferGreeting === 'string'
    ? (input.agentMetadata.preTransferGreeting as string).trim()
    : '';

  const text = override.length > 0
    ? override
    : buildGreetingText(
        resolveBusinessName(input.tenantId, input.tenantName),
        input.agentName,
      );

  if (text.length === 0) return '';

  const voice = resolveVoice();
  const language = resolveLanguage();
  return `<Say voice="${escapeXml(voice)}" language="${escapeXml(language)}">${escapeXml(text)}</Say>`;
}
