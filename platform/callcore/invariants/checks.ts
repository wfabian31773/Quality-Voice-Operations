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
  clauses,
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
  SUCCESS_NEGATORS,
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
const NEGATORS = normalizePhrases(SUCCESS_NEGATORS);

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

/**
 * The latest commit/write result whose action matches the claim must be ok,
 * and recorded after every still-outstanding prepare: a new prepare voids the
 * earlier results until its token retires (an ok commit, or the fail-closed
 * clear). Not scoped by action, so a pending prepare of one kind also blocks
 * earlier-backed claims of another kind (the safe direction).
 */
function latestMatchingOk(facts: CallFacts, actionSegments: readonly string[]): boolean {
  const from = Math.max(0, ...facts.preparedTokens.values());
  for (let i = facts.committed.length - 1; i >= 0; i -= 1) {
    const c = facts.committed[i];
    if (c.kind === 'transfer') continue;
    if (actionSegments.length === 0) return c.ok && i >= from;
    const segments = c.action.toLowerCase().replace(/@\d+$/, '').split(/[._]/);
    if (segments.some((s) => actionSegments.includes(s))) return c.ok && i >= from;
  }
  return false;
}

/** Offsets of each whole-word match of a normalized phrase in ` ${text} `. */
function matchOffsets(normalizedText: string, phrase: string): number[] {
  const padded = ` ${normalizedText} `;
  const offsets: number[] = [];
  for (let i = padded.indexOf(` ${phrase} `); i >= 0; i = padded.indexOf(` ${phrase} `, i + 1)) offsets.push(i);
  return offsets;
}

/**
 * Some phrase occurs at least once without a negator right before it in the
 * same clause. Matches that span clauses still count, so only negation narrows.
 */
function claimsPhrase(norm: string, clauseNorms: readonly string[], phrases: readonly string[]): boolean {
  return phrases.some((p) => {
    const negated = clauseNorms.reduce((n, c) => {
      const padded = ` ${c} `;
      return n + matchOffsets(c, p).filter((i) => NEGATORS.some((neg) => padded.slice(0, i).endsWith(` ${neg}`))).length;
    }, 0);
    return matchOffsets(norm, p).length > negated;
  });
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
  const clauseNorms = clauses(text);
  for (const group of SUCCESS) {
    const claimed = claimsPhrase(norm, clauseNorms, group.phrases) || labels.some((l) => group.labels.includes(l));
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
