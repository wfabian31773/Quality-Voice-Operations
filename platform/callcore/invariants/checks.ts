/**
 * Runtime invariant checker (D3): RUN, SAY, TRANSFER, END.
 *
 * Each check allows, or blocks with a rule id and a fixed model-only
 * instruction. It blocks only hard violations. It never picks the next
 * question and never writes speech for the caller.
 */
import { INSTRUCTIONS } from './instructions';
import {
  canonicalRef,
  findPhrase,
  findRefs,
  leadingLabels,
  normalizeArgs,
  normalizePhrases,
  normalizeSpeech,
  sentences,
} from './normalize';
import {
  SMS_OFF_QUALIFIERS,
  STAGE_DIRECTION_PATTERNS,
  STAGE_DIRECTION_WORDS,
  SUCCESS_CLAIMS,
  TEXT_PROMISE_PHRASES,
  TRANSFER_PHRASES,
} from './phrases';
import type { CallFacts, CheckResult, EndReason, RuleId, RunRecord, RunRequest } from './types';

/** The Nth identical successful read in a row is blocked. */
export const SUCCESS_RUN_CEILING = 10;

/** END reasons allowed while a tool result is still unvoiced. */
export const END_REASONS_PAST_UNVOICED: ReadonlySet<EndReason> = new Set<EndReason>(['max_duration', 'never_heard']);

const OK: CheckResult = { ok: true };

function block(rule: RuleId): CheckResult {
  return { ok: false, rule, instruction: INSTRUCTIONS[rule] };
}

const SUCCESS = SUCCESS_CLAIMS.map((g) => ({
  actionSegments: g.actionSegments,
  phrases: normalizePhrases(g.phrases),
  labels: normalizePhrases(g.labels ?? []),
}));
const TRANSFER = normalizePhrases(TRANSFER_PHRASES);
const STAGE_WORDS = normalizePhrases(STAGE_DIRECTION_WORDS);
const TEXT_PROMISES = normalizePhrases(TEXT_PROMISE_PHRASES);
const QUALIFIERS = normalizePhrases(SMS_OFF_QUALIFIERS);

export function checkRun(facts: CallFacts, req: RunRequest, history: readonly RunRecord[] = []): CheckResult {
  if (!facts.allowedActions.includes(req.action)) return block('run.action_not_allowed');

  if (req.kind === 'commit') {
    const token = req.confirmationToken;
    if (!token) return block('run.commit_without_token');
    if (!facts.preparedTokens.has(token)) return block('run.commit_token_not_prepared');
    if (facts.explicitYesForToken !== token) return block('run.commit_without_yes');
  }

  if (req.kind === 'read') {
    const key = normalizeArgs(req.args);
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const r = history[i];
      if (r.action !== req.action || r.kind !== 'read' || !r.ok || r.argsKey !== key) break;
      streak += 1;
    }
    if (streak + 1 >= SUCCESS_RUN_CEILING) return block('run.success_run_ceiling');
  }

  return OK;
}

/** The latest commit/write result whose action matches the claim must be ok. */
function latestMatchingOk(facts: CallFacts, actionSegments: readonly string[]): boolean {
  for (let i = facts.committed.length - 1; i >= 0; i -= 1) {
    const c = facts.committed[i];
    if (c.kind === 'transfer') continue;
    if (actionSegments.length === 0) return c.ok;
    const segments = c.action.toLowerCase().replace(/@\d+$/, '').split(/[._]/);
    if (segments.some((s) => actionSegments.includes(s))) return c.ok;
  }
  return false;
}

function latestTransferOk(facts: CallFacts): boolean {
  for (let i = facts.committed.length - 1; i >= 0; i -= 1) {
    if (facts.committed[i].kind === 'transfer') return facts.committed[i].ok;
  }
  return false;
}

export function checkSay(facts: CallFacts, text: string): CheckResult {
  const norm = normalizeSpeech(text);

  if (STAGE_DIRECTION_PATTERNS.some((re) => re.test(text)) || findPhrase(norm, STAGE_WORDS)) {
    return block('say.stage_direction');
  }

  const speakable = new Set(facts.speakableNumbers.map(canonicalRef).filter((n) => n.length > 0));
  const refs = findRefs(text).filter((r) => !speakable.has(canonicalRef(r)));
  if (refs.length > 0) {
    if (!facts.voiceRefs) return block('say.ref_not_voiced');
    const known = new Set(facts.committed.filter((c) => c.ok).flatMap((c) => c.refs.map(canonicalRef)));
    if (refs.some((r) => !known.has(canonicalRef(r)))) return block('say.ref_not_committed');
  }

  const labels = leadingLabels(text);
  for (const group of SUCCESS) {
    const claimed = findPhrase(norm, group.phrases) || labels.some((l) => group.labels.includes(l));
    if (claimed && !latestMatchingOk(facts, group.actionSegments)) {
      return block('say.success_before_commit');
    }
  }

  if (findPhrase(norm, TRANSFER) && !latestTransferOk(facts)) return block('say.transfer_without_result');

  // The qualifier only covers a promise in the same sentence.
  if (
    !facts.smsEnabled &&
    sentences(text)
      .map(normalizeSpeech)
      .some((s) => findPhrase(s, TEXT_PROMISES) && !findPhrase(s, QUALIFIERS))
  ) {
    return block('say.text_promise_sms_off');
  }

  return OK;
}

export function checkTransfer(facts: CallFacts): CheckResult {
  return facts.transferNumberConfigured ? OK : block('transfer.no_number');
}

export function checkEnd(facts: CallFacts, reason: EndReason): CheckResult {
  if (facts.unvoicedToolResult && !END_REASONS_PAST_UNVOICED.has(reason)) return block('end.unvoiced_tool_result');
  if (facts.heard && !facts.floorEvaluated) return block('end.floor_not_evaluated');
  return OK;
}
