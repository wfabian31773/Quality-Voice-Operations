/**
 * Unit coverage for the inbound pre-transfer greeting builder.
 *
 * This greeting is the first thing a caller hears — a Twilio <Say> that
 * plays while the OpenAI Realtime media stream connects and warms up,
 * replacing what used to be dead air. The builder takes tenant/agent data
 * (free-text, tenant-controlled) and emits TwiML, so the two things this
 * test guards are:
 *   1. The wording/branding rules (demo brand, agent name, fallbacks).
 *   2. XML-escaping of all dynamic values — a regression here is a TwiML
 *      injection / malformed-response bug that would break every call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildPreTransferSayTwiml, escapeXml } from '../../server/voice-gateway/services/preTransferGreeting';

const GREETING_ENV_KEYS = [
  'TWILIO_PRETRANSFER_GREETING_ENABLED',
  'TWILIO_GREETING_VOICE',
  'TWILIO_GREETING_LANGUAGE',
  'TWILIO_GREETING_BUSINESS_NAME',
] as const;

describe('buildPreTransferSayTwiml', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of GREETING_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of GREETING_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('uses the QVO brand for the demo tenant regardless of its DB name', () => {
    const out = buildPreTransferSayTwiml({
      tenantId: 'demo',
      tenantName: 'Demo Organization',
      agentName: 'Collections Demo',
      agentMetadata: {},
    });
    expect(out).toContain('Thank you for calling Quality Voice Operations.');
    expect(out).toContain('You will now be transferred to Collections Demo.');
    expect(out).not.toContain('Demo Organization');
  });

  it('uses the tenant name for non-demo tenants', () => {
    const out = buildPreTransferSayTwiml({
      tenantId: 'tenant-1',
      tenantName: 'Acme HVAC',
      agentName: 'Front Desk',
      agentMetadata: null,
    });
    expect(out).toContain('Thank you for calling Acme HVAC.');
    expect(out).toContain('You will now be transferred to Front Desk.');
  });

  it('defaults to the premium neural voice and a language attribute', () => {
    const out = buildPreTransferSayTwiml({
      tenantId: 'demo',
      agentName: 'X',
      agentMetadata: null,
    });
    expect(out).toContain('voice="Polly.Joanna-Neural"');
    expect(out).toContain('language="en-US"');
  });

  it('honors voice/language/business env overrides', () => {
    process.env.TWILIO_GREETING_VOICE = 'Polly.Matthew-Generative';
    process.env.TWILIO_GREETING_LANGUAGE = 'en-GB';
    process.env.TWILIO_GREETING_BUSINESS_NAME = 'Globex';
    const out = buildPreTransferSayTwiml({
      tenantId: 'tenant-1',
      tenantName: 'Acme HVAC',
      agentName: 'Front Desk',
      agentMetadata: null,
    });
    expect(out).toContain('voice="Polly.Matthew-Generative"');
    expect(out).toContain('language="en-GB"');
    expect(out).toContain('Thank you for calling Globex.');
    expect(out).not.toContain('Acme HVAC');
  });

  it('falls back to a generic connect clause when the agent name is missing', () => {
    const out = buildPreTransferSayTwiml({
      tenantId: 'demo',
      agentName: '',
      agentMetadata: null,
    });
    expect(out).toContain('You will now be connected to your assistant.');
    expect(out).not.toContain('transferred to');
  });

  it('falls back to "Thank you for calling." when no business name resolves', () => {
    const out = buildPreTransferSayTwiml({
      tenantId: 'tenant-1',
      tenantName: '   ',
      agentName: 'Front Desk',
      agentMetadata: null,
    });
    expect(out).toContain('Thank you for calling. You will now be transferred to Front Desk.');
  });

  it('uses a per-agent metadata override verbatim (still escaped)', () => {
    const out = buildPreTransferSayTwiml({
      tenantId: 'tenant-1',
      tenantName: 'Acme HVAC',
      agentName: 'Front Desk',
      agentMetadata: { preTransferGreeting: 'If this is an emergency, hang up & dial 911.' },
    });
    expect(out).toContain('If this is an emergency, hang up &amp; dial 911.');
    expect(out).not.toContain('Thank you for calling');
  });

  it('XML-escapes dynamic values to prevent TwiML injection', () => {
    const out = buildPreTransferSayTwiml({
      tenantId: 'tenant-1',
      tenantName: 'A&B "Co" <x>',
      agentName: '</Say><Hangup/>',
      agentMetadata: null,
    });
    expect(out).toContain('A&amp;B &quot;Co&quot; &lt;x&gt;');
    expect(out).toContain('&lt;/Say&gt;&lt;Hangup/&gt;');
    expect(out).not.toContain('<Hangup/>');
    // Exactly one opening and one closing <Say> — no injected verbs.
    expect(out.match(/<Say /g)?.length).toBe(1);
    expect(out.match(/<\/Say>/g)?.length).toBe(1);
  });

  it('returns an empty string when greetings are disabled', () => {
    process.env.TWILIO_PRETRANSFER_GREETING_ENABLED = 'false';
    const out = buildPreTransferSayTwiml({
      tenantId: 'demo',
      agentName: 'X',
      agentMetadata: null,
    });
    expect(out).toBe('');
  });
});

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});
