import {
  MASTER_VOICE_AGENT_CONTRACT,
  MASTER_VOICE_AGENT_DEFAULT_VOICE,
  MASTER_VOICE_AGENT_MODEL,
  MASTER_VOICE_AGENT_REALTIME_URL,
} from './masterVoiceAgent';

const OPENAI_VOICE_TO_XAI: Record<string, string> = {
  sage: 'eve',
  alloy: 'ara',
  ash: 'rex',
  ballad: 'sal',
  cedar: 'leo',
  coral: 'ara',
  echo: 'rex',
  marin: 'eve',
  shimmer: 'sal',
  verse: 'leo',
};

export const XAI_BUILTIN_VOICES = ['eve', 'ara', 'rex', 'sal', 'leo'] as const;

export function resolveXaiVoice(voice?: string): string {
  const requested = voice?.trim().toLowerCase();
  if (!requested) return MASTER_VOICE_AGENT_DEFAULT_VOICE;
  if ((XAI_BUILTIN_VOICES as readonly string[]).includes(requested)) return requested;
  return OPENAI_VOICE_TO_XAI[requested] ?? MASTER_VOICE_AGENT_DEFAULT_VOICE;
}

export interface XaiFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface XaiSessionUpdate {
  instructions: string;
  voice: string;
  reasoning: { effort: 'none' | 'high' };
  tools: XaiFunctionTool[];
  turn_detection: {
    type: 'server_vad';
    threshold: number;
    prefix_padding_ms: number;
    silence_duration_ms: number;
    create_response: boolean;
    interrupt_response: boolean;
  };
  audio: {
    input: { format: { type: 'audio/pcmu' } };
    output: { format: { type: 'audio/pcmu' } };
  };
}

export function buildXaiRealtimeUrl(model = MASTER_VOICE_AGENT_MODEL): string {
  return `${MASTER_VOICE_AGENT_REALTIME_URL}?model=${encodeURIComponent(model)}`;
}

export function buildXaiFunctionTools(
  defs: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): XaiFunctionTool[] {
  return defs.map((def) => ({
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: {
      type: 'object',
      properties: (def.parameters.properties as Record<string, unknown>) ?? {},
      required: (def.parameters.required as string[]) ?? [],
      additionalProperties: true,
    },
  }));
}

export function buildXaiSessionUpdate(input: {
  instructions: string;
  voice?: string;
  tools?: XaiFunctionTool[];
  reasoningEffort?: 'none' | 'high';
}): XaiSessionUpdate {
  const session = MASTER_VOICE_AGENT_CONTRACT.session;
  return {
    instructions: input.instructions,
    voice: resolveXaiVoice(input.voice),
    reasoning: { effort: input.reasoningEffort ?? MASTER_VOICE_AGENT_CONTRACT.reasoningEffort },
    tools: input.tools ?? [],
    turn_detection: {
      type: session.turnDetection.type,
      threshold: session.turnDetection.threshold,
      prefix_padding_ms: session.turnDetection.prefixPaddingMs,
      silence_duration_ms: session.turnDetection.silenceDurationMs,
      create_response: session.turnDetection.createResponse,
      interrupt_response: session.turnDetection.interruptResponse,
    },
    audio: {
      input: { format: { type: session.inputFormat } },
      output: { format: { type: session.outputFormat } },
    },
  };
}
