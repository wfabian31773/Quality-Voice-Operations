import { describe, it, expect } from 'vitest';

import { VOICES } from '../../client-app/src/lib/agentVoices';
import { SUPPORTED_VOICES } from '../../server/admin-api/routes/voicePreview';

describe('voice-preview route SUPPORTED_VOICES', () => {
  it('matches the canonical VOICES list (single source of truth)', () => {
    const canonical = [...VOICES].sort();
    const supported = [...SUPPORTED_VOICES].sort();
    expect(
      supported,
      'server/admin-api/routes/voicePreview.ts SUPPORTED_VOICES drifted from ' +
        'client-app/src/lib/agentVoices.ts VOICES. Both must be derived from the ' +
        'canonical VOICES list — do not redeclare voice ids in the route.',
    ).toEqual(canonical);
  });

  it('accepts every canonical voice', () => {
    for (const voice of VOICES) {
      expect(SUPPORTED_VOICES.has(voice), `voice "${voice}" missing from SUPPORTED_VOICES`).toBe(true);
    }
  });

  it('does not accept voices outside the canonical list', () => {
    const canonical = new Set<string>(VOICES);
    for (const voice of SUPPORTED_VOICES) {
      expect(canonical.has(voice), `voice "${voice}" is in SUPPORTED_VOICES but not in canonical VOICES`).toBe(true);
    }
  });
});
