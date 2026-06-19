import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { escapeXml, buildPreTransferSayTwiml } from './preTransferGreeting';

const ENV_KEYS = ['TWILIO_PRETRANSFER_GREETING_ENABLED', 'TWILIO_GREETING_VOICE', 'TWILIO_GREETING_LANGUAGE', 'TWILIO_GREETING_BUSINESS_NAME'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
});

describe('buildPreTransferSayTwiml', () => {
  it('builds a Say fragment with the default voice/language and tenant name', () => {
    const xml = buildPreTransferSayTwiml({ tenantId: 't1', tenantName: 'Acme Dental', agentName: 'Ava' });
    expect(xml).toContain('<Say voice="Polly.Joanna-Neural" language="en-US">');
    expect(xml).toContain('Thank you for calling Acme Dental. You will now be transferred to Ava.');
  });
  it('uses the QVO brand for the demo tenant', () => {
    const xml = buildPreTransferSayTwiml({ tenantId: 'demo', agentName: 'Ava' });
    expect(xml).toContain('Thank you for calling Quality Voice Operations.');
  });
  it('falls back to a generic connect clause without an agent name', () => {
    const xml = buildPreTransferSayTwiml({ tenantId: 't1', tenantName: 'Acme' });
    expect(xml).toContain('You will now be connected to your assistant.');
  });
  it('omits the business name when none is resolvable', () => {
    const xml = buildPreTransferSayTwiml({ tenantId: 't1', agentName: 'Ava' });
    expect(xml).toContain('Thank you for calling. You will now be transferred to Ava.');
  });
  it('honours a per-agent metadata override', () => {
    const xml = buildPreTransferSayTwiml({ tenantId: 't1', agentMetadata: { preTransferGreeting: 'For emergencies hang up and dial 911.' } });
    expect(xml).toContain('For emergencies hang up and dial 911.');
  });
  it('honours the env business-name override and custom voice/language, escaping them', () => {
    process.env.TWILIO_GREETING_BUSINESS_NAME = 'Tom & Jerry';
    process.env.TWILIO_GREETING_VOICE = 'Polly.Matthew';
    process.env.TWILIO_GREETING_LANGUAGE = 'en-GB';
    const xml = buildPreTransferSayTwiml({ tenantId: 't1', agentName: 'Ava' });
    expect(xml).toContain('voice="Polly.Matthew" language="en-GB"');
    expect(xml).toContain('Thank you for calling Tom &amp; Jerry.');
  });
  it('returns an empty string when greetings are disabled', () => {
    process.env.TWILIO_PRETRANSFER_GREETING_ENABLED = 'off';
    expect(buildPreTransferSayTwiml({ tenantId: 't1', agentName: 'Ava' })).toBe('');
  });
});
