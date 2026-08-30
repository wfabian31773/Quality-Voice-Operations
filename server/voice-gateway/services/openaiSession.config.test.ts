import { describe, it, expect } from 'vitest';
import { buildOpenAISessionConfig } from './openaiSession';

describe('buildOpenAISessionConfig (xAI voice session)', () => {
  it('builds the locked xAI telephony session for an aliased OpenAI voice', () => {
    const cfg = buildOpenAISessionConfig({ voice: 'alloy' });
    expect(cfg.voice).toBe('ara');
    expect(cfg.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(cfg.audio.output.format).toEqual({ type: 'audio/pcmu' });
    expect(cfg.turn_detection).toMatchObject({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      create_response: true,
      interrupt_response: true,
    });
    expect(cfg.reasoning).toEqual({ effort: 'none' });
  });

  it('does not pin transcription language so the same session can code-switch', () => {
    const es = buildOpenAISessionConfig({ voice: 'eve', language: 'es' });
    const en = buildOpenAISessionConfig({ voice: 'eve', language: 'en' });
    expect(es.audio.input).not.toHaveProperty('transcription');
    expect(en.audio.input).not.toHaveProperty('transcription');
  });
});
