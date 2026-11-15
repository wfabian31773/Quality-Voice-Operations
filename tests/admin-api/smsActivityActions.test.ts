import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SMS_QUIET_HOURS_ACTIVITY_ACTION } from '../../platform/sms/SmsActivityActions';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist'].includes(entry.name) ? [] : sourceFiles(path);
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe('SMS activity action constraint', () => {
  it('allows every literal logActivity action under server/ and platform/ in migration 053', () => {
    const migration = readFileSync(join(repoRoot, 'migrations/053_sms_check_constraints.sql'), 'utf8');
    const constraint = migration.match(
      /ADD CONSTRAINT sms_activity_action_check\s+CHECK\s*\(action\s+IN\s*\(([^)]+)\)/i,
    );
    expect(constraint, 'migration 053 must define sms_activity_action_check').not.toBeNull();
    const allowedActions = new Set(Array.from(constraint![1].matchAll(/'([^']+)'/g), (match) => match[1]));
    expect(allowedActions.size).toBeGreaterThan(0);
    expect(allowedActions.has(SMS_QUIET_HOURS_ACTIVITY_ACTION)).toBe(true);

    const violations: string[] = [];
    let checked = 0;
    for (const file of ['server', 'platform'].flatMap((directory) => sourceFiles(join(repoRoot, directory)))) {
      const source = readFileSync(file, 'utf8');
      // Covers direct logActivity(...) and member calls such as SmsService.logActivity(...).
      const calls = source.matchAll(/\blogActivity\s*\(\s*[^,]+,\s*[^,]+,\s*(['"`])([a-z_]+)\1\s*[,)]/g);
      for (const call of calls) {
        checked++;
        if (!allowedActions.has(call[2])) {
          const line = source.slice(0, call.index).split('\n').length;
          violations.push(`${relative(repoRoot, file)}:${line}: ${call[2]}`);
        }
      }
    }
    expect(checked, 'the source scan must find literal activity actions').toBeGreaterThan(0);
    expect(violations, 'logActivity actions must satisfy sms_activity_action_check').toEqual([]);
  });
});
