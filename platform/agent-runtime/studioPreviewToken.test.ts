import { describe, expect, it } from 'vitest';
import {
  signStudioPreviewToken,
  studioPreviewStreamPath,
  verifyStudioPreviewToken,
} from './studioPreviewToken';

const claims = { tenantId: 't1', agentId: 'a1', userId: 'u1' };

describe('studioPreviewToken', () => {
  it('round-trips a preview token and rejects a different secret', () => {
    const token = signStudioPreviewToken(claims, 60, 'secret-a');
    expect(verifyStudioPreviewToken(token, 'secret-a')).toEqual(claims);
    expect(verifyStudioPreviewToken(token, 'secret-b')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signStudioPreviewToken(claims, 0, 'secret-a');
    expect(verifyStudioPreviewToken(token, 'secret-a')).toBeNull();
  });

  it('builds the voice-gateway proxy path used by the studio', () => {
    expect(studioPreviewStreamPath('abc+def')).toBe('/vg/studio/stream?token=abc%2Bdef');
  });
});
