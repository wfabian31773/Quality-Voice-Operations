import { describe, it, expect } from 'vitest';
import { buildOpenAISessionConfig } from './openaiSession';

describe('buildOpenAISessionConfig', () => {
  it('builds the telephony-tuned base config for English', () => {
    const cfg = buildOpenAISessionConfig({ voice: 'alloy' });
    const audio = cfg.audio;
    expect(cfg.voice).toBe('alloy');
    expect(audio.input.format).toBe('g711_ulaw');
    expect(audio.input.transcription).toEqual({ model: 'gpt-4o-mini-transcribe' });
    expect(audio.input.noiseReduction).toEqual({ type: 'far_field' });
    expect(audio.input.turnDetection).toMatchObject({ type: 'server_vad', threshold: 0.5, prefixPaddingMs: 300, silenceDurationMs: 500, createResponse: true, interruptResponse: true });
    expect(audio.output).toEqual({ format: 'g711_ulaw', voice: 'alloy' });
  });

  it('keeps automatic language detection for a non-English preferred greeting', () => {
    const cfg = buildOpenAISessionConfig({ voice: 'verse', language: 'es' });
    const t = (cfg as { audio: { input: { transcription: { model: string; language?: string } } } }).audio.input.transcription;
    expect(t).toEqual({ model: 'gpt-4o-mini-transcribe' });
  });

  it('omits the language for an explicit English session', () => {
    const cfg = buildOpenAISessionConfig({ voice: 'verse', language: 'en' });
    const t = (cfg as { audio: { input: { transcription: { language?: string } } } }).audio.input.transcription;
    expect(t).not.toHaveProperty('language');
  });

  it('includes reasoning.effort only for a reasoning-capable model', () => {
    const cfg = buildOpenAISessionConfig({ voice: 'alloy', model: 'gpt-realtime-2', reasoningEffort: 'medium' }) as { reasoning?: { effort: string } };
    expect(cfg.reasoning).toEqual({ effort: 'medium' });
  });

  it('omits reasoning.effort when the model does not support it', () => {
    const cfg = buildOpenAISessionConfig({ voice: 'alloy', model: 'gpt-4o-realtime-preview', reasoningEffort: 'high' }) as { reasoning?: unknown };
    expect(cfg.reasoning).toBeUndefined();
  });

  it('omits reasoning.effort when no effort is requested', () => {
    const cfg = buildOpenAISessionConfig({ voice: 'alloy', model: 'gpt-realtime-2' }) as { reasoning?: unknown };
    expect(cfg.reasoning).toBeUndefined();
  });
});
