/**
 * G3 boundary: the invariant checker is pure and vertical-agnostic. Source
 * files (not tests) may import only siblings in this folder and `zod`, and
 * touch no I/O, clock or randomness.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const FORBIDDEN_GLOBALS =
  /\b(?:Date|Math\.random|process|setTimeout|setInterval|setImmediate|queueMicrotask|fetch|XMLHttpRequest|WebSocket|crypto|performance|console|globalThis|require)\b/;
// The vertical-name scan for all of platform/callcore/** lives in platform/callcore/boundary.test.ts (RT-01, #116).

describe('callcore/invariants boundary', () => {
  it('finds the module sources', () => {
    expect(sources.map((s) => s.file).sort()).toEqual(
      expect.arrayContaining(['checks.ts', 'facts.ts', 'index.ts', 'instructions.ts', 'normalize.ts', 'phrases.ts', 'types.ts']),
    );
  });

  it('imports only siblings in this folder (and zod)', () => {
    for (const { file, text } of sources) {
      for (const [, spec] of text.matchAll(IMPORT_RE)) {
        expect(spec.startsWith('./') || spec === 'zod', `${file} imports ${spec}`).toBe(true);
        expect(spec.includes('..'), `${file} imports ${spec}`).toBe(false);
      }
    }
  });

  it('uses no I/O, clock or randomness', () => {
    for (const { file, text } of sources) {
      expect(stripComments(text), file).not.toMatch(FORBIDDEN_GLOBALS);
    }
  });

  it('the scanners catch what they should (fixture)', () => {
    const bad = "import type { X } from '../contracts/types';\nconst t = Date.now();";
    expect([...bad.matchAll(IMPORT_RE)].map((m) => m[1])).toEqual(['../contracts/types']);
    expect(stripComments(bad)).toMatch(FORBIDDEN_GLOBALS);
  });
});
