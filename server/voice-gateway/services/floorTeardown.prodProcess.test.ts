/**
 * RT-12 / G6: the hangup floor, end to end, in the production process shape.
 *
 * Azul's floor was wired and filed zero tickets for 10 days because tests ran
 * under one Node/module loader and production under another. So this test
 * doesn't import the teardown code: it spawns the harness exactly as
 * render.yaml starts qvo-voice (`node --import tsx <entry>.ts`, cwd = repo
 * root, Node major from .node-version), and reads what the real teardown
 * filed. Only the database (pg-mem) and the xAI socket are fake; see the
 * harness header.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const HARNESS = 'server/voice-gateway/services/__prodProcess__/floorTeardownHarness.ts';
const RESULT_MARKER = 'RT12_PROD_PROCESS_RESULT ';

interface FloorTicketRow {
  description: string;
  contactName: string;
  contactPhone: string;
  kind: string;
  source: string;
  callId: string | null;
}

interface CaseResult {
  name: string;
  callId: string;
  outcomes: string[];
  floorTickets: FloorTicketRow[];
  floorIdempotencyKeys: string[];
  floorAuditResultCodes: string[];
  toolOutputs: Array<{ tool: string; success: unknown }>;
}

interface HarnessReport {
  error?: string;
  runtime: {
    node: string;
    execArgv: string[];
    entry: string;
    vitest: boolean;
    cjsRequire: boolean;
    streamRouteLoaded: boolean;
    fakeSockets: number;
  };
  cases: CaseResult[];
}

/** The production Node major: .nvmrc if present, else .node-version (this repo has .node-version = 20). */
function productionNodeMajor(): string {
  for (const file of ['.nvmrc', '.node-version']) {
    const full = path.join(REPO_ROOT, file);
    if (existsSync(full)) return readFileSync(full, 'utf8').trim().replace(/^v/, '').split('.')[0];
  }
  throw new Error('no .nvmrc or .node-version at the repo root');
}

/**
 * A clean environment: no vitest variables, no inherited NODE_OPTIONS, no
 * secrets. The database URL is never dialed (the harness fakes `pg`).
 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TZ: 'UTC',
    APP_ENV: 'development',
    DATABASE_URL: 'postgres://pg-mem.invalid/qvo',
  };
}

function runHarness(): Promise<{ report: HarnessReport; output: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', HARNESS], { cwd: REPO_ROOT, env: childEnv() });
    // Collect bytes and decode once: a chunk boundary can split a multi-byte character.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { out.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { err.push(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARKER));
      if (!line) {
        reject(new Error(`harness printed no result (exit ${code})\n${stderr.slice(-4000)}\n${stdout.slice(-4000)}`));
        return;
      }
      resolve({ report: JSON.parse(line.slice(RESULT_MARKER.length)) as HarnessReport, output: stdout + stderr, code });
    });
  });
}

describe('hangup floor in the production process (node --import tsx, Node from .node-version)', () => {
  let report: HarnessReport;
  let output: string;
  let byName: Map<string, CaseResult>;

  beforeAll(async () => {
    const run = await runHarness();
    report = run.report;
    output = run.output;
    if (report.error) throw new Error(`harness failed: ${report.error}`);
    expect(run.code).toBe(0);
    byName = new Map(report.cases.map((c) => [c.name, c]));
  }, 180_000);

  it('ran under the production Node major and the tsx loader, not vitest', () => {
    expect(report.runtime.node.split('.')[0]).toBe(productionNodeMajor());
    expect(process.versions.node.split('.')[0]).toBe(productionNodeMajor());
    expect(report.runtime.execArgv).toEqual(['--import', 'tsx']);
    expect(report.runtime.entry).toBe(HARNESS);
    expect(report.runtime.vitest).toBe(false);
    // render.yaml has no "type": "module": tsx loads the .ts sources as CommonJS, like production.
    expect(report.runtime.cjsRequire).toBe(true);
    expect(report.runtime.streamRouteLoaded).toBe(true);
    expect(report.runtime.fakeSockets).toBe(report.cases.length);
  });

  it('(a) a heard caller who asked for something and hung up gets exactly one floor ticket with their own lines, redacted', () => {
    const c = byName.get('request_then_hangup')!;
    expect(c.floorTickets).toHaveLength(1);
    expect(c.outcomes).toEqual(['filed']);
    const [ticket] = c.floorTickets;
    expect(ticket.kind).toBe('message');
    expect(ticket.source).toBe('ai_agent');
    expect(ticket.callId).toBe(c.callId);
    expect(ticket.description).toContain('Hi, this is Dana, I need a fade Friday at nine');
    // Agent lines are never on the ticket.
    expect(ticket.description).not.toContain('let me check');
    // The spoken callback number is masked to its last four digits.
    expect(ticket.description).not.toContain('555 010 0142');
    expect(ticket.description).toContain('0142');
    // The caller's phone comes from the (encrypted) call_sessions row, not from the model.
    expect(ticket.contactPhone).toBe('+15550100142');
    expect(c.floorIdempotencyKeys).toEqual([`call-${c.callId}-floor`]);
    expect(c.floorAuditResultCodes).toEqual(['ok']);
  });

  it('(b) teardown running twice still files one ticket', () => {
    const c = byName.get('teardown_twice')!;
    expect(c.outcomes).toEqual(['filed', 'filed']);
    expect(c.floorTickets).toHaveLength(1);
    expect(c.floorAuditResultCodes).toEqual(['ok']);
  });

  it('(c) a caller who only said their name gets no ticket', () => {
    const c = byName.get('name_only')!;
    expect(c.outcomes).toEqual(['nothing_substantive']);
    expect(c.floorTickets).toHaveLength(0);
  });

  it('(d) a write tool that returned ok on the call stops the floor, even though hasCallArtifact cannot see it', () => {
    const c = byName.get('write_tool_ok')!;
    expect(c.toolOutputs).toEqual([{ tool: 'createServiceTicket', success: true }]);
    expect(c.outcomes).toEqual(['skipped_tool_write']);
    expect(c.floorTickets).toHaveLength(0);
    expect(c.floorAuditResultCodes).toEqual([]);
  });

  it('(e) a never-heard caller gets no ticket', () => {
    const c = byName.get('never_heard')!;
    expect(c.outcomes).toEqual(['never_heard']);
    expect(c.floorTickets).toHaveLength(0);
  });

  it('logs only the floor outcome code, never the caller text or phone', () => {
    const floorLines = output.split('\n').filter((l) => l.includes('floor_evaluated'));
    expect(floorLines.length).toBeGreaterThanOrEqual(report.cases.length);
    for (const line of floorLines) {
      expect(line).not.toMatch(/fade|Dana|0142/);
    }
  });
});
