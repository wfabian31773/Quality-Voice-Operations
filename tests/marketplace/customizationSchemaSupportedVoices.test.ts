import { describe, it, expect } from 'vitest';

import { VOICES } from '../../client-app/src/lib/agentVoices';
import { VALID_VOICES, buildCustomizationSchema } from '../../platform/marketplace/CustomizationSchema';

describe('marketplace CustomizationSchema VALID_VOICES', () => {
  it('matches the canonical VOICES list (single source of truth)', () => {
    const canonical = [...VOICES].sort();
    const supported = [...VALID_VOICES].sort();
    expect(
      supported,
      'platform/marketplace/CustomizationSchema.ts VALID_VOICES drifted from ' +
        'client-app/src/lib/agentVoices.ts VOICES. Both must be derived from the ' +
        'canonical VOICES list — do not redeclare voice ids in the schema.',
    ).toEqual(canonical);
  });

  it('accepts every canonical voice', () => {
    for (const voice of VOICES) {
      expect(VALID_VOICES.has(voice), `voice "${voice}" missing from VALID_VOICES`).toBe(true);
    }
  });

  it('does not accept voices outside the canonical list', () => {
    const canonical = new Set<string>(VOICES);
    for (const voice of VALID_VOICES) {
      expect(canonical.has(voice), `voice "${voice}" is in VALID_VOICES but not in canonical VOICES`).toBe(true);
    }
  });

  it('exposes voice picker options derived from canonical VOICES', () => {
    const schema = buildCustomizationSchema(null);
    const voiceField = schema.customizableFields.find((f) => f.key === 'voice');
    expect(voiceField, 'voice field missing from default customizable fields').toBeDefined();
    const optionValues = (voiceField!.options ?? []).map((o) => o.value).sort();
    expect(
      optionValues,
      'voice picker options drifted from canonical VOICES list',
    ).toEqual([...VOICES].sort());
  });
});
