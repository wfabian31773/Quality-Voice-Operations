import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { readBuildInfo, getBuildInfo, __resetBuildInfoForTests } from './buildInfo';

const SHA = '32164aa8f00dbabe0123456789abcdef01234567';
const BUILD_TIME = '2026-10-17T14:05:09Z';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'build-info-'));
  file = path.join(dir, '.build-info.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __resetBuildInfoForTests();
});

describe('readBuildInfo', () => {
  it('uses a valid RENDER_GIT_COMMIT and the build-info file', () => {
    writeFileSync(file, JSON.stringify({ commit: SHA, buildTime: BUILD_TIME }));
    expect(readBuildInfo({ RENDER_GIT_COMMIT: SHA }, file)).toEqual({
      commit: SHA,
      commitShort: '32164aa',
      buildTime: BUILD_TIME,
      marker: `32164aa@${BUILD_TIME}`,
    });
  });

  it('accepts a short SHA and normalizes case', () => {
    expect(readBuildInfo({ RENDER_GIT_COMMIT: ' 32164AA8 ' }, file)).toMatchObject({
      commit: '32164aa8',
      commitShort: '32164aa',
    });
  });

  it('is all unknown with no env and no file', () => {
    expect(readBuildInfo({}, file)).toEqual({
      commit: 'unknown',
      commitShort: 'unknown',
      buildTime: 'unknown',
      marker: 'unknown@unknown',
    });
  });

  it.each(['', 'abc', 'not-a-sha-at-all', 'g'.repeat(40), 'a'.repeat(41), 'password=hunter2'])(
    'rejects a malformed RENDER_GIT_COMMIT (%j) without echoing it',
    (value) => {
      const info = readBuildInfo({ RENDER_GIT_COMMIT: value }, file);
      expect(info.commit).toBe('unknown');
      if (value) expect(JSON.stringify(info)).not.toContain(value);
    },
  );

  it('falls back to the file commit when the env var is missing', () => {
    writeFileSync(file, JSON.stringify({ commit: SHA, buildTime: BUILD_TIME }));
    expect(readBuildInfo({}, file)).toMatchObject({ commit: SHA, marker: `32164aa@${BUILD_TIME}` });
  });

  it('keeps the commit when the build-info file is missing', () => {
    expect(readBuildInfo({ RENDER_GIT_COMMIT: SHA }, file)).toMatchObject({
      buildTime: 'unknown',
      marker: '32164aa@unknown',
    });
  });

  it.each([
    ['not json', '{oops'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a bad buildTime', JSON.stringify({ buildTime: 'yesterday' })],
    ['a non-string buildTime', JSON.stringify({ buildTime: 1760709909 })],
    ['a bad commit', JSON.stringify({ commit: 'unknown', buildTime: 'x' })],
  ])('treats a malformed build-info file (%s) as unknown', (_label, content) => {
    writeFileSync(file, content);
    expect(readBuildInfo({}, file)).toEqual({
      commit: 'unknown',
      commitShort: 'unknown',
      buildTime: 'unknown',
      marker: 'unknown@unknown',
    });
  });
});

describe('getBuildInfo', () => {
  it('reads once and caches', () => {
    const prev = process.env.RENDER_GIT_COMMIT;
    try {
      process.env.RENDER_GIT_COMMIT = SHA;
      const first = getBuildInfo();
      process.env.RENDER_GIT_COMMIT = 'ffffffff';
      expect(getBuildInfo()).toBe(first);
      expect(first.commit).toBe(SHA);
    } finally {
      if (prev === undefined) delete process.env.RENDER_GIT_COMMIT;
      else process.env.RENDER_GIT_COMMIT = prev;
    }
  });
});
