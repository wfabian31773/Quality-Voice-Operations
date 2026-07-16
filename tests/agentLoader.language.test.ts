import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { loadAgentConfig } from '../server/voice-gateway/services/agentLoader';
import { buildOpenAISessionConfig } from '../server/voice-gateway/services/openaiSession';
import {
  AGENT_LANGUAGES,
  DEFAULT_AGENT_LANGUAGE,
  getAgentLanguageLabel,
} from '../platform/agent-templates/agentLanguages';
import type { TenantId } from '../platform/core/types';

const NON_ENGLISH_CODES = ['es', 'fr', 'de', 'pt', 'zh'] as const;

function makeCtx(language?: string) {
  return {
    tenantId: randomUUID() as TenantId,
    agentId: 'agent_test',
    agentType: 'answering-service',
    callerPhone: '+15551234567',
    dbAgent: {
      name: 'Test Agent',
      voice: 'sage',
      model: 'gpt-4o-realtime-preview',
      metadata: { practiceName: 'Test Clinic' },
      ...(language !== undefined ? { language } : {}),
    },
  };
}

describe('loadAgentConfig - language plumbing', () => {
  it.each(NON_ENGLISH_CODES)(
    'sets a preferred greeting language while retaining natural switching for %s',
    (code) => {
      const cfg = loadAgentConfig(makeCtx(code));
      const label = getAgentLanguageLabel(code);
      const directive = `Begin in ${label}, then follow the caller's language naturally.`;

      expect(cfg.language).toBe(code);
      expect(cfg.systemPrompt).toContain(directive);

      const occurrences = cfg.systemPrompt.split(directive).length - 1;
      expect(occurrences).toBe(1);
    },
  );

  it('uses English as a preferred greeting without pinning the call', () => {
    const cfg = loadAgentConfig(makeCtx('en'));
    expect(cfg.language).toBe(DEFAULT_AGENT_LANGUAGE);
    expect(cfg.systemPrompt).toContain("Begin in English, then follow the caller's language naturally.");
    expect(cfg.systemPrompt).not.toContain('All spoken responses must be in English');
  });

  it('falls back to English when no language is supplied', () => {
    const cfg = loadAgentConfig(makeCtx());
    expect(cfg.language).toBe(DEFAULT_AGENT_LANGUAGE);
    expect(cfg.systemPrompt).toContain('Preferred greeting language: English');
  });

  it('falls back to English when the language code is unknown', () => {
    const cfg = loadAgentConfig(makeCtx('xx-unknown'));
    expect(cfg.language).toBe(DEFAULT_AGENT_LANGUAGE);
    expect(cfg.systemPrompt).toContain('Preferred greeting language: English');
  });

  it('only appends the directive once even when system prompt is reused', () => {
    const first = loadAgentConfig(makeCtx('es'));
    const ctxWithExistingPrompt = {
      ...makeCtx('es'),
      dbAgent: {
        name: 'Test Agent',
        voice: 'sage',
        model: 'gpt-4o-realtime-preview',
        language: 'es',
        system_prompt: first.systemPrompt,
        metadata: { practiceName: 'Test Clinic' },
      },
    };
    const second = loadAgentConfig(ctxWithExistingPrompt);
    expect(second.language).toBe('es');
    const directive = `Begin in Spanish, then follow the caller's language naturally.`;
    const occurrences = second.systemPrompt.split(directive).length - 1;
    expect(occurrences).toBe(1);
  });

  it('supports every non-English language code in the catalog', () => {
    for (const lang of AGENT_LANGUAGES) {
      if (lang.code === DEFAULT_AGENT_LANGUAGE) continue;
      const cfg = loadAgentConfig(makeCtx(lang.code));
      expect(cfg.language).toBe(lang.code);
      const directive = `Begin in ${lang.label}, then follow the caller's language naturally.`;
      expect(cfg.systemPrompt).toContain(directive);
    }
  });
});

describe('buildOpenAISessionConfig - transcription language plumbing', () => {
  it.each(NON_ENGLISH_CODES)(
    'keeps automatic transcription language detection for %s',
    (code) => {
      const sessionConfig = buildOpenAISessionConfig({ voice: 'sage', language: code });
      expect(sessionConfig.audio.input.transcription).toEqual({
        model: 'gpt-4o-mini-transcribe',
      });
      expect(sessionConfig.audio.input.transcription).not.toHaveProperty('language');
    },
  );

  it('omits transcription.language when the agent language is English', () => {
    const sessionConfig = buildOpenAISessionConfig({ voice: 'sage', language: 'en' });
    expect(sessionConfig.audio.input.transcription).toEqual({
      model: 'gpt-4o-mini-transcribe',
    });
    expect(sessionConfig.audio.input.transcription).not.toHaveProperty('language');
  });

  it('omits transcription.language when no language is supplied', () => {
    const sessionConfig = buildOpenAISessionConfig({ voice: 'sage' });
    expect(sessionConfig.audio.input.transcription).toEqual({
      model: 'gpt-4o-mini-transcribe',
    });
    expect(sessionConfig.audio.input.transcription).not.toHaveProperty('language');
  });

  it('omits transcription.language when language is an empty string', () => {
    const sessionConfig = buildOpenAISessionConfig({ voice: 'sage', language: '' });
    expect(sessionConfig.audio.input.transcription).not.toHaveProperty('language');
  });

  it('keeps voice and audio formats consistent regardless of language', () => {
    const en = buildOpenAISessionConfig({ voice: 'sage', language: 'en' });
    const es = buildOpenAISessionConfig({ voice: 'sage', language: 'es' });
    expect(en.voice).toBe('sage');
    expect(es.voice).toBe('sage');
    expect(en.audio.input.format).toBe('g711_ulaw');
    expect(es.audio.input.format).toBe('g711_ulaw');
    expect(en.audio.output).toEqual({ format: 'g711_ulaw', voice: 'sage' });
    expect(es.audio.output).toEqual({ format: 'g711_ulaw', voice: 'sage' });
  });
});

describe('end-to-end: loadAgentConfig flows into buildOpenAISessionConfig', () => {
  it.each(NON_ENGLISH_CODES)(
    'language %s controls the greeting but does not pin transcription',
    (code) => {
      const agentConfig = loadAgentConfig(makeCtx(code));
      const sessionConfig = buildOpenAISessionConfig({
        voice: agentConfig.voice,
        language: agentConfig.language,
      });
      expect(sessionConfig.audio.input.transcription).toEqual({
        model: 'gpt-4o-mini-transcribe',
      });
      expect(sessionConfig.audio.input.transcription).not.toHaveProperty('language');
    },
  );

  it('English agent config produces no transcription language override', () => {
    const agentConfig = loadAgentConfig(makeCtx('en'));
    const sessionConfig = buildOpenAISessionConfig({
      voice: agentConfig.voice,
      language: agentConfig.language,
    });
    expect(sessionConfig.audio.input.transcription).not.toHaveProperty('language');
  });
});
