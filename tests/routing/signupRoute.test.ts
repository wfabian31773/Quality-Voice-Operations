import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..', '..');

describe('signup route wiring', () => {
  it('registers /signup on the in-app router (not the marketing sitemap table)', () => {
    const app = readFileSync(join(repoRoot, 'client-app/src/App.tsx'), 'utf8');
    expect(app).toMatch(/path="\/signup"/);
    expect(app).toMatch(/pages\/public\/Signup/);
  });

  it('does not add /signup to the Preact marketing route table', () => {
    const publicApp = readFileSync(join(repoRoot, 'client-app/src/PublicApp.tsx'), 'utf8');
    expect(publicApp).not.toMatch(/path="\/signup"/);
  });
});
