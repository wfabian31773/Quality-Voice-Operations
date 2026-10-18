// Composer boundary (plan D1/D5): one generic composer for every agent. No
// file in this folder, tests included, may name a vertical; a vertical is
// only ever a template passed in. This file is excluded because it lists them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPOSER = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const VERTICAL_WORDS = [
  'barber',
  'salon',
  'nail',
  'restaurant',
  'lawyer',
  'legal',
  'real estate',
  'dispatch',
  'dental',
  'healthcare',
  'medical',
  'clinic',
] as const;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs|cjs|snap)$/.test(entry.name) ? [full] : [];
  });
}

function verticalNamesIn(text: string): string[] {
  const lower = text.toLowerCase();
  return VERTICAL_WORDS.filter((word) => lower.includes(word));
}

describe('platform/agent-runtime/composer boundary', () => {
  const files = sourceFiles(COMPOSER).filter((f) => path.resolve(f) !== SELF);

  it('finds the composer files', () => {
    expect(files.map((f) => path.relative(COMPOSER, f))).toEqual(
      expect.arrayContaining(['compose.ts', 'index.ts', 'runtimeTools.ts', 'types.ts']),
    );
  });

  it('names no vertical, in code, comments, tests or snapshots', () => {
    const offenders = files.flatMap((file) =>
      verticalNamesIn(fs.readFileSync(file, 'utf8')).map((word) => `${path.relative(COMPOSER, file)}: ${word}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan catches a vertical name', () => {
    expect(verticalNamesIn('import { X } from "../../agent-templates/barbershop";')).toEqual(['barber']);
  });
});
