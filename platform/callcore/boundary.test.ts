// Runtime boundary (rev 3 D1): platform/callcore is pure and generic. No file
// here may import the server, the database layer or a transport, and no
// vertical name may appear outside comments in contract data files.
// This file is excluded from the vertical-name scan because it lists them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CALLCORE = path.join(ROOT, 'platform', 'callcore');
const SELF = fileURLToPath(import.meta.url);

const VERTICAL_WORDS = ['barber', 'salon', 'restaurant', 'lawyer', 'dispatch'];
const TRANSPORTS = /^(node:)?(http|https|net|tls|dgram)$|^(twilio|ws|express|pg|pg-mem|openai|@openai\/.*|@xai\/.*)(\/.*)?$/;
/** Non-library contract files: pure data, the only place a vertical name may appear (in comments). */
const CONTRACT_LIBRARY = new Set(['types.ts', 'validate.ts', 'enforce.ts', 'index.ts']);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

function importsOf(source: string): string[] {
  const specs: string[] = [];
  const re = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(re)) specs.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return specs;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const isTest = (file: string) => /\.test\.[cm]?[jt]sx?$/.test(file);
const isContractData = (file: string) =>
  path.dirname(file) === path.join(CALLCORE, 'contracts') && !isTest(file) && !CONTRACT_LIBRARY.has(path.basename(file));

describe('platform/callcore boundary', () => {
  const files = sourceFiles(CALLCORE);

  it('finds the contract files', () => {
    expect(files.map((f) => path.relative(CALLCORE, f))).toEqual(
      expect.arrayContaining(['contracts/types.ts', 'contracts/validate.ts', 'contracts/enforce.ts', 'contracts/bookingBook.ts', 'contracts/index.ts']),
    );
  });

  it('imports nothing from server/, platform/db or a transport module', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          const rel = path.relative(ROOT, path.resolve(path.dirname(file), spec)).split(path.sep).join('/');
          if (rel === 'server' || rel.startsWith('server/') || rel === 'platform/db' || rel.startsWith('platform/db/')) {
            offenders.push(`${path.relative(ROOT, file)} -> ${spec}`);
          }
        } else if (TRANSPORTS.test(spec) || spec.startsWith('server/') || spec.includes('platform/db')) {
          offenders.push(`${path.relative(ROOT, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('non-test sources import only zod and other callcore files', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !isTest(f))) {
      for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
        const inside = spec.startsWith('.') && path.resolve(path.dirname(file), spec).startsWith(CALLCORE + path.sep);
        if (!inside && spec !== 'zod') offenders.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no vertical (comments in contract data files excepted)', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => path.resolve(f) !== SELF)) {
      const raw = fs.readFileSync(file, 'utf8');
      const text = (isContractData(file) ? stripComments(raw) : raw).toLowerCase();
      for (const word of VERTICAL_WORDS) {
        if (text.includes(word)) offenders.push(`${path.relative(ROOT, file)}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
