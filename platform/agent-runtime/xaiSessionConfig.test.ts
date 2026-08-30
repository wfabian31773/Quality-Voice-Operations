import { describe, expect, it } from 'vitest';
import {
  MASTER_VOICE_AGENT_CONTRACT,
  MASTER_VOICE_AGENT_MODEL,
} from './masterVoiceAgent';
import {
  buildXaiFunctionTools,
  buildXaiRealtimeUrl,
  buildXaiSessionUpdate,
  resolveXaiVoice,
} from './xaiSessionConfig';

describe('xAI session contract', () => {
  it('pins the realtime URL and production model', () => {
    expect(buildXaiRealtimeUrl()).toBe(`wss://api.x.ai/v1/realtime?model=${encodeURIComponent(MASTER_VOICE_AGENT_MODEL)}`);
    expect(MASTER_VOICE_AGENT_CONTRACT.provider).toBe('xai');
  });

  it('maps legacy OpenAI voices onto the xAI roster', () => {
    expect(resolveXaiVoice('sage')).toBe('eve');
    expect(resolveXaiVoice('alloy')).toBe('ara');
    expect(resolveXaiVoice('eve')).toBe('eve');
    expect(resolveXaiVoice('unknown-voice')).toBe('eve');
  });

  it('builds a locked session.update payload with function tools', () => {
    const tools = buildXaiFunctionTools([
      { name: 'send_sms', description: 'Send SMS', parameters: { properties: { body: { type: 'string' } }, required: ['body'] } },
    ]);
    const session = buildXaiSessionUpdate({
      instructions: 'You are the receptionist.',
      voice: 'sage',
      tools,
    });
    expect(session.voice).toBe('eve');
    expect(session.audio.input.format.type).toBe('audio/pcmu');
    expect(session.tools[0]).toMatchObject({ type: 'function', name: 'send_sms' });
    expect(session.reasoning.effort).toBe('none');
  });
});
