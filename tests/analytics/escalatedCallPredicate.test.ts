// @vitest-environment node
/**
 * Since #143 (FINALIZE-DRAIN) a transferred call ends in CALL_COMPLETED and
 * keeps its escalation in escalation_target; only a call still mid-transfer
 * (or a reasoning escalation) is in ESCALATED. So a report that decides
 * "was this call escalated" must use
 *   lifecycle_state = 'ESCALATED' OR escalation_target IS NOT NULL
 * and never lifecycle_state alone.
 *
 * Every SQL line in server/** and platform/** that tests lifecycle_state
 * against 'ESCALATED' (or the legacy `escalated = true` column) must also
 * accept escalation_target IS NOT NULL. Lines whose IN list already includes
 * CALL_COMPLETED count every finished call, so a transferred one too.
 *
 * With DATABASE_URL reachable, each predicate, taken verbatim from the
 * source, is also run against a TEMP call_sessions table: a CALL_COMPLETED
 * row with escalation_target set must match it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ESCALATION_TEST = /lifecycle_state\s*(?:=\s*'ESCALATED'|IN\s*\([^)]*'ESCALATED')|\bescalated\s*=\s*true\b/;

interface Hit { file: string; line: number; text: string }

function escalationPredicateLines(): Hit[] {
  // Plain pathspecs: `*` also matches `/`, so these are every .ts file under each tree.
  const files = execFileSync('git', ['ls-files', '--', 'server/*.ts', 'platform/*.ts'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !/\.(test|spec)\.ts$/.test(f));
  const hits: Hit[] = [];
  for (const file of files) {
    readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').forEach((text, i) => {
      if (ESCALATION_TEST.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

/**
 * The predicate around the match on a hit line: the innermost parenthesis
 * enclosing it (`FILTER (WHERE ...)`, `AND (... OR ...)`), or, with none,
 * the rest of the line (`AND cs.lifecycle_state IN (...)`).
 */
function extractPredicate(text: string): string {
  const at = text.search(ESCALATION_TEST);
  let open = -1;
  for (let i = at - 1, depth = 0; i >= 0; i--) {
    if (text[i] === ')') depth++;
    if (text[i] === '(' && depth-- === 0) { open = i; break; }
  }
  if (open < 0) return text.slice(at);
  for (let i = open, depth = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i).replace(/^WHERE\s+/, '');
  }
  throw new Error(`unbalanced predicate: ${text}`);
}

const hits = escalationPredicateLines();

describe('escalated-call predicate (transfers end in CALL_COMPLETED since #143)', () => {
  it('finds the known readers', () => {
    const files = new Set(hits.map((h) => h.file));
    for (const f of [
      'platform/analytics/AnalyticsService.ts',
      'platform/analytics/CaseStudyService.ts',
      'platform/autopilot/AutopilotEngine.ts',
      'platform/digital-twin/DigitalTwinModelService.ts',
      'platform/workforce/WorkforceOptimizationEngine.ts',
      'platform/workforce/WorkforceRevenueService.ts',
      'server/admin-api/routes/operations.ts',
    ]) expect(files).toContain(f);
  });

  it('no SQL reader decides "escalated" from lifecycle_state (or the escalated column) alone', () => {
    const stragglers = hits.filter((h) => !h.text.includes('escalation_target IS NOT NULL') && !/IN\s*\([^)]*'CALL_COMPLETED'/.test(h.text));
    expect(stragglers.map((h) => `${h.file}:${h.line}: ${h.text}`)).toEqual([]);
  });
});

const URL_RAW = process.env.DATABASE_URL ?? '';

async function connectOrNull(): Promise<Client | null> {
  if (!URL_RAW) return null;
  const client = new Client({ connectionString: URL_RAW, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

const client = await connectOrNull();

describe.skipIf(!client)('escalated-call predicates, run as written (real Postgres)', () => {
  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  it('every predicate counts a CALL_COMPLETED call with escalation_target set, and not one without', async () => {
    await client!.query(`CREATE TEMP TABLE call_sessions (
      id TEXT PRIMARY KEY, lifecycle_state TEXT NOT NULL, escalation_target TEXT,
      escalated BOOLEAN DEFAULT false, duration_seconds INT
    )`);
    await client!.query(`INSERT INTO call_sessions (id, lifecycle_state, escalation_target, duration_seconds) VALUES
      ('transferred', 'CALL_COMPLETED', '+15550001111', 60),
      ('plain', 'CALL_COMPLETED', NULL, 60)`);
    for (const h of hits) {
      const predicate = extractPredicate(h.text);
      const { rows } = await client!.query(`SELECT id FROM call_sessions cs WHERE ${predicate} ORDER BY id`);
      expect({ at: `${h.file}:${h.line}`, ids: rows.map((r) => r.id) }).toEqual({
        at: `${h.file}:${h.line}`,
        // A list that already includes CALL_COMPLETED counts every finished call.
        ids: /'CALL_COMPLETED'/.test(predicate) ? ['plain', 'transferred'] : ['transferred'],
      });
    }
  });

  it('getCallAnalytics Outcomes buckets (completed / escalated / failed), run as written, put each call in at most one', async () => {
    const source = readFileSync(path.join(REPO_ROOT, 'platform/analytics/AnalyticsService.ts'), 'utf8');
    const bucket = (alias: string) => {
      const m = new RegExp(`COUNT\\(\\*\\) FILTER \\(WHERE (.+?)\\)::int AS ${alias}\\b`).exec(source);
      if (!m) throw new Error(`no ${alias} in getCallAnalytics`);
      return m[1];
    };
    await client!.query(`CREATE TEMP TABLE outcome_calls (id TEXT PRIMARY KEY, lifecycle_state TEXT NOT NULL, escalation_target TEXT)`);
    await client!.query(`INSERT INTO outcome_calls VALUES
      ('plain', 'CALL_COMPLETED', NULL),
      ('transferred', 'CALL_COMPLETED', '+15550001111'),
      ('mid_transfer', 'ESCALATED', '+15550001111'),
      ('reasoning_escalation', 'ESCALATED', NULL),
      ('failed', 'CALL_FAILED', NULL),
      ('failed_after_transfer', 'CALL_FAILED', '+15550001111'),
      ('active', 'ACTIVE_CONVERSATION', NULL)`);
    const ids = async (alias: string) =>
      (await client!.query(`SELECT id FROM outcome_calls WHERE ${bucket(alias)} ORDER BY id`)).rows.map((r) => r.id);
    expect({
      completed: await ids('completed_calls'),
      escalated: await ids('escalated_calls'),
      failed: await ids('failed_calls'),
    }).toEqual({
      completed: ['plain'],
      escalated: ['failed_after_transfer', 'mid_transfer', 'reasoning_escalation', 'transferred'],
      failed: ['failed'],
    });
  });
});
