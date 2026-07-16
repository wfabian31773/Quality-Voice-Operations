import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const sessionSource = readFileSync(resolve(root, 'server/voice-gateway/services/openaiSession.ts'), 'utf8');
const numberLookupSource = readFileSync(resolve(root, 'server/voice-gateway/services/numberLookup.ts'), 'utf8');

describe('Master Voice Agent construction architecture', () => {
  it('constructs exactly one realtime session and transitions role context on that session', () => {
    expect(sessionSource.match(/new RealtimeSession\(/g)).toHaveLength(1);
    expect(sessionSource).toContain('.updateAgent(');
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
