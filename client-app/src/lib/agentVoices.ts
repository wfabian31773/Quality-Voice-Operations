/**
 * Canonical OpenAI Realtime voice list.
 *
 * This is the single source of truth for the set of voices we expose in the
 * voice dropdown and reference from `RECOMMENDED_VOICES_BY_LANGUAGE` in
 * `./agentLanguages.ts`. Both must stay in sync, and the test in
 * `tests/components/voiceLanguageRecommendations.test.ts` enforces that every
 * recommended voice is a member of this list (so a voice removed from this
 * list will fail CI rather than silently dangling in the recommendation map).
 *
 * REVIEW CADENCE
 * --------------
 *   Quarterly (or sooner if OpenAI announces new/removed Realtime voices on
 *   the changelog: https://platform.openai.com/docs/changelog).
 *
 * LISTENING TEST (used to grade voices per-language)
 * --------------------------------------------------
 *   For each candidate voice / language pair, generate a 25–40 second sample
 *   that exercises:
 *     1. A neutral greeting ("Hi, thanks for calling Acme — how can I help?")
 *     2. A number-heavy line (phone number, address, dollar amount)
 *     3. A question + interrupt (caller cuts the agent off mid-sentence)
 *     4. An empathetic acknowledgement ("I'm sorry to hear that.")
 *   Two reviewers grade each sample 1–5 on:
 *     - Pronunciation / accent authenticity for the language
 *     - Prosody on the interrupt + recovery
 *     - Comfort over a 30-second listen (no robotic / nasal artifacts)
 *   A voice must average ≥ 3.5 on every axis to be added to
 *   `RECOMMENDED_VOICES_BY_LANGUAGE` for that language. Scores are tracked in
 *   the team's voice-grading sheet (linked from the engineering wiki).
 *
 * UPDATING
 * --------
 *   1. Add or remove voice ids in `VOICES` below.
 *   2. Update the per-language arrays in `agentLanguages.ts` to reflect any
 *      new grades.
 *   3. Run `npm test -- voiceLanguageRecommendations` and confirm green.
 */
export const VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
] as const;

export type AgentVoice = (typeof VOICES)[number];

const VOICE_SET: ReadonlySet<string> = new Set(VOICES);

export function isKnownVoice(voice: string): voice is AgentVoice {
  return VOICE_SET.has(voice);
}
