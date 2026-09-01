export const GROK_IMPROVE_MODEL = 'grok-4';
export const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';

const MAX_INSTRUCTIONS = 32_000;
const MAX_GOAL = 2_000;

export class ImproveUnavailableError extends Error {
  constructor(message = 'Improve with Grok is unavailable right now.') {
    super(message);
    this.name = 'ImproveUnavailableError';
  }
}

export class ImproveRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImproveRequestError';
  }
}

export interface ImproveVoiceAgentInput {
  instructions: string;
  goal?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

export interface ImproveVoiceAgentResult {
  instructions: string;
  model: string;
}

const SYSTEM_PROMPT = [
  'You rewrite system instructions for a QVO voice agent.',
  'The live runtime is already locked: xAI Grok Voice Agent, Master Voice Agent 2.0.0, grok-voice-think-fast-2.0.',
  'Do not mention models, providers, APIs, or invent new tools.',
  'Keep the same job, language, and safety boundaries.',
  'Tighten the copy so it is spoken-word ready: short sentences, listen first, no second greeting.',
  'Return only the improved instructions. No title, no markdown fence, no commentary.',
].join(' ');

export function buildImproveInput(instructions: string, goal?: string): string {
  const parts = [`Current instructions:\n${instructions.trim()}`];
  if (goal?.trim()) parts.push(`Operator request:\n${goal.trim()}`);
  return parts.join('\n\n');
}

function readOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const output = record.output;
  if (Array.isArray(output)) {
    const chunks: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) chunks.push(text.trim());
      }
    }
    if (chunks.length > 0) return chunks.join('\n').trim();
  }
  return '';
}

export async function improveVoiceAgentCopy(
  input: ImproveVoiceAgentInput,
): Promise<ImproveVoiceAgentResult> {
  const instructions = input.instructions.trim();
  if (!instructions) {
    throw new ImproveRequestError('instructions are required');
  }
  if (instructions.length > MAX_INSTRUCTIONS) {
    throw new ImproveRequestError(`instructions exceed ${MAX_INSTRUCTIONS} characters`);
  }
  const goal = input.goal?.trim() ?? '';
  if (goal.length > MAX_GOAL) {
    throw new ImproveRequestError(`goal exceeds ${MAX_GOAL} characters`);
  }

  const apiKey = input.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new ImproveUnavailableError();
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const upstream = await fetchImpl(XAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROK_IMPROVE_MODEL,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildImproveInput(instructions, goal) },
      ],
    }),
  });

  if (!upstream.ok) {
    throw new ImproveUnavailableError();
  }

  const payload = await upstream.json() as unknown;
  const improved = readOutputText(payload);
  if (!improved) {
    throw new ImproveUnavailableError();
  }

  return {
    instructions: improved.slice(0, MAX_INSTRUCTIONS),
    model: GROK_IMPROVE_MODEL,
  };
}
