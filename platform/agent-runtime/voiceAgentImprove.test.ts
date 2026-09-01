import { describe, expect, it, vi } from 'vitest';
import {
  GROK_IMPROVE_MODEL,
  ImproveRequestError,
  ImproveUnavailableError,
  buildImproveInput,
  improveVoiceAgentCopy,
} from './voiceAgentImprove';

describe('buildImproveInput', () => {
  it('includes the operator goal when provided', () => {
    const text = buildImproveInput('Answer the phone.', 'Sound warmer');
    expect(text).toContain('Answer the phone.');
    expect(text).toContain('Sound warmer');
  });
});

describe('improveVoiceAgentCopy', () => {
  it('rejects empty instructions', async () => {
    await expect(improveVoiceAgentCopy({ instructions: '   ' })).rejects.toBeInstanceOf(ImproveRequestError);
  });

  it('fails closed without an xAI key', async () => {
    await expect(improveVoiceAgentCopy({
      instructions: 'Answer the phone.',
      apiKey: '',
    })).rejects.toBeInstanceOf(ImproveUnavailableError);
  });

  it('returns only the rewritten instructions from the Responses API', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      output_text: 'Greet the caller, then listen.',
    }), { status: 200 }));

    const result = await improveVoiceAgentCopy({
      instructions: 'Say hello a lot.',
      apiKey: 'xai-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      instructions: 'Greet the caller, then listen.',
      model: GROK_IMPROVE_MODEL,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe(GROK_IMPROVE_MODEL);
    expect(JSON.stringify(body.input)).not.toMatch(/openai|gpt-4/i);
  });

  it('treats an upstream failure as unavailable', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(improveVoiceAgentCopy({
      instructions: 'Answer the phone.',
      apiKey: 'xai-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toBeInstanceOf(ImproveUnavailableError);
  });
});
