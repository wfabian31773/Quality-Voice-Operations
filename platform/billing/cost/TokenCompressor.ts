import { createLogger } from '../../core/logger';

const logger = createLogger('TOKEN_COMPRESSOR');

const DEFAULT_MAX_CONTEXT_TOKENS = 4096;
const APPROX_CHARS_PER_TOKEN = 4;
const SUMMARY_TARGET_RATIO = 0.3;

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompressionResult {
  messages: ConversationMessage[];
  originalTokenCount: number;
  compressedTokenCount: number;
  tokensSaved: number;
  wasTruncated: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function estimateMessagesTokens(messages: ConversationMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

function summarizeMessages(messages: ConversationMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const prefix = msg.role === 'user' ? 'Customer' : msg.role === 'assistant' ? 'Agent' : 'System';
    const truncated = msg.content.length > 200 ? msg.content.substring(0, 200) + '...' : msg.content;
    lines.push(`${prefix}: ${truncated}`);
  }
  return `[Conversation summary]\n${lines.join('\n')}`;
}

function deduplicateSystemPrompts(messages: ConversationMessage[]): ConversationMessage[] {
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  if (systemMessages.length <= 1) return messages;

  const seen = new Set<string>();
  const uniqueSystem: ConversationMessage[] = [];
  for (const msg of systemMessages) {
    const key = msg.content.substring(0, 100);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueSystem.push(msg);
    }
  }

  return [...uniqueSystem, ...nonSystemMessages];
}

export function compressConversation(
  messages: ConversationMessage[],
  maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS,
): CompressionResult {
  const originalTokenCount = estimateMessagesTokens(messages);

  if (originalTokenCount <= maxContextTokens) {
    return {
      messages,
      originalTokenCount,
      compressedTokenCount: originalTokenCount,
      tokensSaved: 0,
      wasTruncated: false,
    };
  }

  let compressed = deduplicateSystemPrompts(messages);
  let currentTokens = estimateMessagesTokens(compressed);

  if (currentTokens <= maxContextTokens) {
    return {
      messages: compressed,
      originalTokenCount,
      compressedTokenCount: currentTokens,
      tokensSaved: originalTokenCount - currentTokens,
      wasTruncated: false,
    };
  }

  const systemMessages = compressed.filter(m => m.role === 'system');
  const conversationMessages = compressed.filter(m => m.role !== 'system');

  const systemTokens = estimateMessagesTokens(systemMessages);
  const availableForConversation = maxContextTokens - systemTokens;

  const recentCount = Math.max(4, Math.floor(conversationMessages.length * 0.3));
  const recentMessages = conversationMessages.slice(-recentCount);
  const olderMessages = conversationMessages.slice(0, -recentCount);

  if (olderMessages.length > 0) {
    const summary = summarizeMessages(olderMessages);
    const summaryMessage: ConversationMessage = {
      role: 'system',
      content: summary,
    };
    compressed = [...systemMessages, summaryMessage, ...recentMessages];
  } else {
    compressed = [...systemMessages, ...recentMessages];
  }

  currentTokens = estimateMessagesTokens(compressed);

  if (currentTokens > maxContextTokens) {
    while (compressed.length > 2 && estimateMessagesTokens(compressed) > maxContextTokens) {
      const firstNonSystem = compressed.findIndex(m => m.role !== 'system');
      if (firstNonSystem === -1) break;
      compressed.splice(firstNonSystem, 1);
    }
    currentTokens = estimateMessagesTokens(compressed);
  }

  const tokensSaved = originalTokenCount - currentTokens;

  logger.info('Conversation compressed', {
    originalTokens: originalTokenCount,
    compressedTokens: currentTokens,
    tokensSaved,
    originalMessages: messages.length,
    compressedMessages: compressed.length,
  });

  return {
    messages: compressed,
    originalTokenCount,
    compressedTokenCount: currentTokens,
    tokensSaved,
    wasTruncated: true,
  };
}

export function shouldCompress(messages: ConversationMessage[], maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS): boolean {
  const tokens = estimateMessagesTokens(messages);
  return tokens > maxContextTokens * 0.8;
}
