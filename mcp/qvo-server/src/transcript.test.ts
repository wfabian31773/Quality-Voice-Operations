import { describe, expect, it } from 'vitest';
import { renderTranscript } from './transcript';

describe('inspector transcript', () => {
  it('matches TRANSCRIPT.md (list tools, call qvo.get_tenant)', async () => {
    const transcript = await renderTranscript();
    expect(transcript).toContain('"name": "qvo_get_tenant"');
    await expect(transcript).toMatchFileSnapshot('../TRANSCRIPT.md');
  });
});
