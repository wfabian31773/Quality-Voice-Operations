/**
 * Deploy marker (VA-14, gate G0): which commit is live, and when it was
 * built, so a tester can check `/health` before trusting a test call.
 *
 *   - `commit` comes from Render's built-in RENDER_GIT_COMMIT (runtime), else
 *     from the build-info file. Only a 7–40 char hex SHA is accepted.
 *   - `buildTime` comes from `.build-info.json`, written at the repo root by
 *     scripts/render/build.sh (Render has no build-time variable).
 *
 * Anything missing or malformed becomes `'unknown'`; this never throws and
 * never echoes any other env value.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

export interface BuildInfo {
  commit: string;
  commitShort: string;
  buildTime: string;
  marker: string;
}

type Env = Record<string, string | undefined>;

export const BUILD_INFO_PATH = path.resolve(__dirname, '../../.build-info.json');

const UNKNOWN = 'unknown';
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const BUILD_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

type BuildInfoFile = { commit?: unknown; buildTime?: unknown };

function readBuildInfoFile(file: string): BuildInfoFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as BuildInfoFile) : {};
  } catch {
    return {};
  }
}

function asSha(value: unknown): string | null {
  return typeof value === 'string' && SHA_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/** Uncached; prefer `getBuildInfo()` outside tests. */
export function readBuildInfo(env: Env = process.env, file: string = BUILD_INFO_PATH): BuildInfo {
  const fromFile = readBuildInfoFile(file);
  const commit = asSha(env.RENDER_GIT_COMMIT) ?? asSha(fromFile.commit) ?? UNKNOWN;
  const buildTime =
    typeof fromFile.buildTime === 'string' && BUILD_TIME_RE.test(fromFile.buildTime) ? fromFile.buildTime : UNKNOWN;
  const commitShort = commit === UNKNOWN ? UNKNOWN : commit.slice(0, 7);
  return { commit, commitShort, buildTime, marker: `${commitShort}@${buildTime}` };
}

let cached: BuildInfo | null = null;

/** Read once per process (startup), then served from memory. */
export function getBuildInfo(): BuildInfo {
  if (!cached) cached = readBuildInfo();
  return cached;
}

export function __resetBuildInfoForTests(): void {
  cached = null;
}
