/**
 * GLOBAL voice-conversation principles appended to EVERY agent prompt by
 * `agentLoader.finalize()`. These rules are platform-wide and intentionally
 * not per-agent-overridable — they encode the conversational quality bar
 * that every voice agent on QVO (demo, template, user-built) must meet.
 *
 * Why a separate fragment instead of baking it into each template prompt:
 * - One place to evolve. Every lesson we learn from a real bad call lands
 *   here once and benefits all agents on the next call.
 * - User-built agents (DB system_prompt, "generic" fallback) get the same
 *   conversational hygiene without the agent author having to remember.
 * - Pairs with the locked-in transport defaults in `buildOpenAISessionConfig`
 *   (server_vad + far_field + barge-in). The transport layer enables natural
 *   conversation; this fragment teaches the model to actually use it.
 *
 * Format note: kept terse and imperative. Realtime models pay the most
 * attention to the *end* of the system prompt, so we want this short and
 * concrete — long, hedged prose gets ignored.
 */
export {
  MASTER_VOICE_CONVERSATION_POLICY as VOICE_CONVERSATION_PRINCIPLES,
} from '../agent-runtime/masterVoiceAgent';
