import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);

describe('docs_feedback admin status routes', () => {
  it('PATCH /docs/feedback/comments/:id is registered with auth + platform admin guards', () => {
    const lines = supportFile.split('\n');
    const idx = lines.findIndex((l) =>
      l.includes("router.patch('/docs/feedback/comments/:id'"),
    );
    expect(idx, 'PATCH /docs/feedback/comments/:id not registered').toBeGreaterThan(-1);
    expect(lines[idx]).toMatch(/requireAuth/);
    expect(lines[idx]).toMatch(/requirePlatformAdmin/);
  });

  it('GET /docs/feedback/comments is registered with auth + platform admin guards', () => {
    const lines = supportFile.split('\n');
    const idx = lines.findIndex((l) =>
      l.includes("router.get('/docs/feedback/comments'"),
    );
    expect(idx).toBeGreaterThan(-1);
    expect(lines[idx]).toMatch(/requireAuth/);
    expect(lines[idx]).toMatch(/requirePlatformAdmin/);
  });

  it('only allows the new/resolved/hidden status values', () => {
    expect(supportFile).toMatch(
      /VALID_FEEDBACK_STATUSES\s*=\s*new Set\(\['new', 'resolved', 'hidden'\]\)/,
    );
  });

  it('updates the audit columns when changing status', () => {
    expect(supportFile).toMatch(/status_updated_at\s*=\s*NOW\(\)/);
    expect(supportFile).toMatch(/status_updated_by\s*=\s*\$3/);
  });

  it('defaults the comments listing filter to "new"', () => {
    expect(supportFile).toMatch(
      /req\.query\.status\s*\?\s*String\(req\.query\.status\)\s*:\s*'new'/,
    );
  });
});

describe('docs_feedback status migration', () => {
  const migration = readFileSync(
    join(process.cwd(), 'migrations/056_docs_feedback_status.sql'),
    'utf8',
  );

  it('adds a status column with new/resolved/hidden CHECK constraint', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS status/);
    expect(migration).toMatch(/DEFAULT 'new'/);
    expect(migration).toMatch(
      /CHECK \(status IN \('new', 'resolved', 'hidden'\)\)/,
    );
  });

  it('adds audit columns and a status index', () => {
    expect(migration).toMatch(/status_updated_at/);
    expect(migration).toMatch(/status_updated_by/);
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS docs_feedback_status_idx/);
  });
});
