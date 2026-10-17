import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(process.cwd(), 'migrations/123_tickets_v2.sql'), 'utf8');
const statements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('123_tickets_v2.sql', () => {
  it('adds kind, callback_due_at, intake and urgency with safe defaults', () => {
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message'/);
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS callback_due_at TIMESTAMPTZ;/);
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS intake JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS urgency TEXT NOT NULL DEFAULT 'normal'/);
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS source_call_ref VARCHAR\(128\);/);
  });

  it('sets a lock_timeout before taking any lock', () => {
    expect(statements.trim()).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('checks the allowed kinds and urgencies with NOT VALID constraints (no full-table scan)', () => {
    expect(statements).toMatch(
      /tickets_kind_check\s+CHECK \(kind IN \('message', 'callback', 'complaint', 'quote_request', 'intake', 'other'\)\) NOT VALID;/,
    );
    expect(statements).toMatch(/tickets_urgency_check\s+CHECK \(urgency IN \('normal', 'urgent'\)\) NOT VALID;/);
    expect(statements).toMatch(/tickets_intake_object_check\s+CHECK \(jsonb_typeof\(intake\) = 'object'\) NOT VALID;/);
    const checks = [...statements.matchAll(/ADD CONSTRAINT \w+\s+CHECK[^;]*;/g)].map((m) => m[0]);
    expect(checks).toHaveLength(3);
    for (const check of checks) expect(check).toMatch(/NOT VALID;$/);
    // VALIDATE CONSTRAINT is a later migration.
    expect(statements).not.toMatch(/VALIDATE CONSTRAINT/i);
  });

  it('allows at most one ticket.opened outbox row per ticket', () => {
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_outbox_ticket_opened\s+ON ticket_outbox \(tenant_id, \(payload->>'ticketId'\)\)\s+WHERE event_type = 'ticket\.opened';/,
    );
  });

  it('indexes (tenant_id, status, callback_due_at)', () => {
    expect(statements).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_tickets_tenant_status_callback_due\s+ON tickets \(tenant_id, status, callback_due_at\)/,
    );
  });

  it('is expand-only and re-runnable', () => {
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/ALTER COLUMN/i);
    expect(statements).not.toMatch(/\bUPDATE\s+tickets\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    for (const match of statements.matchAll(/ADD CONSTRAINT (\w+)/g)) {
      expect(statements).toContain(`conname = '${match[1]}'`);
    }
    for (const line of statements.split('\n').filter((l) => /ADD COLUMN|CREATE (UNIQUE )?INDEX/.test(l))) {
      expect(line).toMatch(/IF NOT EXISTS/);
    }
  });

  it('leaves tickets RLS untouched', () => {
    expect(statements).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(statements).not.toMatch(/POLICY/i);
  });
});
