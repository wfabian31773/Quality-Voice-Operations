import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const sessionSource = readFileSync(resolve(root, 'server/voice-gateway/services/openaiSession.ts'), 'utf8');
const transportSource = readFileSync(resolve(root, 'server/voice-gateway/services/xaiRealtimeTransport.ts'), 'utf8');
const numberLookupSource = readFileSync(resolve(root, 'server/voice-gateway/services/numberLookup.ts'), 'utf8');

describe('Master Voice Agent construction architecture', () => {
  it('constructs exactly one xAI voice session and keeps role transitions on that session', () => {
    expect(sessionSource.match(/new XaiVoiceSession\(/g)).toHaveLength(1);
    expect(sessionSource.match(/new XaiRealtimeTransport\(/g)).toHaveLength(1);
    expect(sessionSource).toContain('updateSession(');
    expect(sessionSource).not.toContain('new RealtimeSession(');
    expect(transportSource).toContain('wss://api.x.ai/v1/realtime');
  });

  it('does not dynamically route or downgrade the locked production model', () => {
    expect(sessionSource).not.toContain('routeQuery(');
    expect(sessionSource).not.toContain('TIER_MODEL_MAP');
    expect(sessionSource).not.toContain("activeModelTier = 'economy'");
  });

  it('loads the canonical tenant timezone and records core/role versions on the call event', () => {
    expect(numberLookupSource).toContain('tenant_timezone');
    expect(sessionSource).toContain('coreVersion: agentConfig.coreVersion');
    expect(sessionSource).toContain('rolePackageVersion: agentConfig.rolePackageVersion');
  });
});
