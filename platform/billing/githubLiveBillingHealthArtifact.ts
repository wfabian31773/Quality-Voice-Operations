/**
 * Fetches the latest live-billing-health screenshot artifact from the
 * `billing-health-live-stripe.yml` GitHub Actions workflow so the
 * Platform Admin "Billing config health" panel can show operators a
 * thumbnail / modal preview of the most recent green run without
 * digging into the Actions tab.
 *
 * Sister context:
 *   - `.github/workflows/billing-health-live-stripe.yml` — the nightly
 *     CI job. Uploads `.ci-logs/` as the
 *     `billing-health-live-stripe-artifacts` artifact, which contains
 *     `screenshots/platform-admin-billing-health-live-success.png` on
 *     green runs and `…-failure.png` on red ones.
 *   - `tests/e2e/platformAdminBillingHealthLive.spec.ts` — writes the
 *     screenshots above.
 *   - `server/admin-api/routes/platformBillingHealth.ts` — exposes
 *     `getLiveBillingHealthSummary()` + `streamLatestSuccessScreenshot()`
 *     under the `/platform/billing-config-health/last-live-*` admin
 *     routes.
 *
 * Configuration env vars (all optional — when `GITHUB_REPOSITORY` or
 * `GITHUB_TOKEN` are missing the panel hides the live-screenshot card
 * and the routes return `configured: false` instead of erroring):
 *
 *   GITHUB_REPOSITORY                            "owner/repo"
 *   GITHUB_TOKEN                                 PAT or GITHUB_TOKEN with `actions:read` + `issues:read`
 *   GITHUB_BILLING_HEALTH_WORKFLOW_FILE          default `billing-health-live-stripe.yml`
 *   GITHUB_BILLING_HEALTH_ARTIFACT_NAME          default `billing-health-live-stripe-artifacts`
 *   GITHUB_BILLING_HEALTH_SUCCESS_SCREENSHOT     default `platform-admin-billing-health-live-success.png`
 *   GITHUB_BILLING_HEALTH_DRIFT_LABEL            default `billing-health-live-drift`
 *   GITHUB_BILLING_HEALTH_CACHE_TTL_MS           default 5 minutes
 */
import JSZip from 'jszip';
import { createLogger } from '../core/logger';

const logger = createLogger('BILLING_HEALTH_LIVE_ARTIFACT');

const DEFAULT_WORKFLOW_FILE = 'billing-health-live-stripe.yml';
const DEFAULT_ARTIFACT_NAME = 'billing-health-live-stripe-artifacts';
const DEFAULT_SUCCESS_SCREENSHOT = 'platform-admin-billing-health-live-success.png';
const DEFAULT_DRIFT_LABEL = 'billing-health-live-drift';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_CACHE_TTL_MS = 30 * 1000;
const MAX_CACHE_TTL_MS = 60 * 60 * 1000;

const GITHUB_API = 'https://api.github.com';

export interface LiveBillingHealthRunSummary {
  id: number;
  conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | 'neutral' | 'skipped' | null;
  status: string;
  htmlUrl: string;
  runStartedAt: string;
  updatedAt: string;
  headSha: string | null;
  headBranch: string | null;
  event: string | null;
}

export interface LiveBillingHealthSuccessSummary extends LiveBillingHealthRunSummary {
  artifactId: number | null;
  artifactExpired: boolean;
  artifactSizeInBytes: number | null;
  screenshotAvailable: boolean;
}

/**
 * Links to the failure screenshot for the most recent failed CI run.
 * Surfaced in ops Slack alerts so on-call can confirm the visual
 * regression directly from the alert thread without bouncing through
 * the Admin console or hunting through the Actions tab.
 *
 * Both URLs require a logged-in GitHub session (same audience as the
 * `Workflow run:` link the alert already includes), so this is the
 * "GitHub run-artifact URL gated by the existing GITHUB_TOKEN" path
 * called out on task #1476 — not a public/proxied PNG.
 */
export interface LiveBillingHealthFailureScreenshotLinks {
  /** `https://github.com/<owner>/<repo>/actions/runs/<id>` for the failure run. */
  workflowRunHtmlUrl: string;
  /**
   * `https://github.com/<owner>/<repo>/actions/runs/<id>/artifacts/<artifactId>`
   * — direct link to the uploaded artifact zip page that contains
   * `screenshots/platform-admin-billing-health-live-failure.png`.
   * `null` when the artifact has expired (>14 days) or the upload step
   * was skipped (gate did not run).
   */
  artifactPageUrl: string | null;
  /** Whether GitHub still has the artifact (false once it ages out of the 14-day retention). */
  artifactExpired: boolean;
  /** ISO timestamp of when the failure run completed (best-effort context for the alert). */
  failureRunUpdatedAt: string;
}

export interface LiveBillingHealthTrackingIssue {
  number: number;
  htmlUrl: string;
  title: string;
  updatedAt: string;
}

export interface LiveBillingHealthSummary {
  configured: boolean;
  /** Human-readable reason when `configured === false`. */
  unavailableReason?: string;
  workflowHtmlUrl: string | null;
  trackingIssueLabelSearchUrl: string | null;
  latestRun: LiveBillingHealthRunSummary | null;
  latestSuccess: LiveBillingHealthSuccessSummary | null;
  openTrackingIssue: LiveBillingHealthTrackingIssue | null;
  /** Populated when GitHub returned an error we want the panel to surface. */
  error: string | null;
  fetchedAt: string;
}

interface ResolvedConfig {
  owner: string;
  repo: string;
  token: string;
  workflowFile: string;
  artifactName: string;
  successScreenshot: string;
  driftLabel: string;
  cacheTtlMs: number;
}

interface CachedScreenshot {
  artifactId: number;
  buffer: Buffer;
  contentType: string;
}

let summaryCache: { value: LiveBillingHealthSummary; expiresAt: number } | null = null;
let screenshotCache: { value: CachedScreenshot; expiresAt: number } | null = null;
let inFlightSummary: Promise<LiveBillingHealthSummary> | null = null;
let failureLinksCache:
  | { value: LiveBillingHealthFailureScreenshotLinks | null; expiresAt: number }
  | null = null;
let inFlightFailureLinks: Promise<LiveBillingHealthFailureScreenshotLinks | null> | null =
  null;

function parseCacheTtl(): number {
  const raw = process.env.GITHUB_BILLING_HEALTH_CACHE_TTL_MS;
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_CACHE_TTL_MS || parsed > MAX_CACHE_TTL_MS) {
    logger.warn('Ignoring invalid GITHUB_BILLING_HEALTH_CACHE_TTL_MS — using default', {
      raw,
      default: DEFAULT_CACHE_TTL_MS,
    });
    return DEFAULT_CACHE_TTL_MS;
  }
  return parsed;
}

function resolveConfig(): ResolvedConfig | { configured: false; reason: string } {
  const repoSlug = (process.env.GITHUB_REPOSITORY || '').trim();
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (!repoSlug || !token) {
    const missing: string[] = [];
    if (!repoSlug) missing.push('GITHUB_REPOSITORY');
    if (!token) missing.push('GITHUB_TOKEN');
    return {
      configured: false,
      reason: `Live screenshot integration disabled — missing ${missing.join(' and ')}.`,
    };
  }
  const slashIdx = repoSlug.indexOf('/');
  if (slashIdx <= 0 || slashIdx === repoSlug.length - 1) {
    return {
      configured: false,
      reason: `GITHUB_REPOSITORY (${repoSlug}) is not in "owner/repo" form.`,
    };
  }
  return {
    owner: repoSlug.slice(0, slashIdx),
    repo: repoSlug.slice(slashIdx + 1),
    token,
    workflowFile:
      (process.env.GITHUB_BILLING_HEALTH_WORKFLOW_FILE || '').trim() || DEFAULT_WORKFLOW_FILE,
    artifactName:
      (process.env.GITHUB_BILLING_HEALTH_ARTIFACT_NAME || '').trim() || DEFAULT_ARTIFACT_NAME,
    successScreenshot:
      (process.env.GITHUB_BILLING_HEALTH_SUCCESS_SCREENSHOT || '').trim()
      || DEFAULT_SUCCESS_SCREENSHOT,
    driftLabel:
      (process.env.GITHUB_BILLING_HEALTH_DRIFT_LABEL || '').trim() || DEFAULT_DRIFT_LABEL,
    cacheTtlMs: parseCacheTtl(),
  };
}

function buildHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'qvo-platform-admin-billing-health',
  };
}

async function ghJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface GhWorkflowRun {
  id: number;
  conclusion: LiveBillingHealthRunSummary['conclusion'];
  status: string;
  html_url: string;
  run_started_at: string;
  updated_at: string;
  head_sha: string | null;
  head_branch: string | null;
  event: string | null;
}

interface GhArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  archive_download_url: string;
}

interface GhIssue {
  number: number;
  html_url: string;
  title: string;
  updated_at: string;
  pull_request?: unknown;
}

function toRunSummary(run: GhWorkflowRun): LiveBillingHealthRunSummary {
  return {
    id: run.id,
    conclusion: run.conclusion,
    status: run.status,
    htmlUrl: run.html_url,
    runStartedAt: run.run_started_at,
    updatedAt: run.updated_at,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    event: run.event,
  };
}

async function fetchLatestRun(cfg: ResolvedConfig): Promise<GhWorkflowRun | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`
    + `/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/runs?per_page=1`;
  const data = await ghJson<{ workflow_runs: GhWorkflowRun[] }>(url, cfg.token);
  return data.workflow_runs?.[0] ?? null;
}

async function fetchLatestSuccessRun(cfg: ResolvedConfig): Promise<GhWorkflowRun | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`
    + `/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/runs?status=success&per_page=1`;
  const data = await ghJson<{ workflow_runs: GhWorkflowRun[] }>(url, cfg.token);
  return data.workflow_runs?.[0] ?? null;
}

async function fetchLatestFailureRun(cfg: ResolvedConfig): Promise<GhWorkflowRun | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`
    + `/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/runs?status=failure&per_page=1`;
  const data = await ghJson<{ workflow_runs: GhWorkflowRun[] }>(url, cfg.token);
  return data.workflow_runs?.[0] ?? null;
}

async function fetchArtifactForRun(
  cfg: ResolvedConfig,
  runId: number,
): Promise<GhArtifact | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`
    + `/actions/runs/${runId}/artifacts?per_page=100`;
  const data = await ghJson<{ artifacts: GhArtifact[] }>(url, cfg.token);
  return data.artifacts?.find((a) => a.name === cfg.artifactName) ?? null;
}

async function fetchOpenTrackingIssue(cfg: ResolvedConfig): Promise<GhIssue | null> {
  // The issues endpoint returns PRs too; widen `per_page` so a stray PR
  // sitting at the top of the labelled list (rare, but possible if a
  // contributor hand-applies the label) doesn't push the actual
  // tracking issue out of view when we filter PRs out below.
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`
    + `/issues?state=open&labels=${encodeURIComponent(cfg.driftLabel)}&per_page=10`;
  const data = await ghJson<GhIssue[]>(url, cfg.token);
  return data.find((i) => !i.pull_request) ?? null;
}

function buildLabelSearchUrl(cfg: ResolvedConfig): string {
  const q = `is:open is:issue label:${cfg.driftLabel}`;
  return `https://github.com/${cfg.owner}/${cfg.repo}/issues?q=${encodeURIComponent(q)}`;
}

function buildWorkflowHtmlUrl(cfg: ResolvedConfig): string {
  return `https://github.com/${cfg.owner}/${cfg.repo}/actions/workflows/${cfg.workflowFile}`;
}

function emptySummary(reason: string): LiveBillingHealthSummary {
  return {
    configured: false,
    unavailableReason: reason,
    workflowHtmlUrl: null,
    trackingIssueLabelSearchUrl: null,
    latestRun: null,
    latestSuccess: null,
    openTrackingIssue: null,
    error: null,
    fetchedAt: new Date().toISOString(),
  };
}

async function loadSummaryUncached(): Promise<LiveBillingHealthSummary> {
  const cfg = resolveConfig();
  if ('configured' in cfg && cfg.configured === false) {
    return emptySummary(cfg.reason);
  }
  const resolved = cfg as ResolvedConfig;
  const workflowHtmlUrl = buildWorkflowHtmlUrl(resolved);
  const trackingIssueLabelSearchUrl = buildLabelSearchUrl(resolved);

  try {
    const [latestRun, latestSuccessRun, openIssue] = await Promise.all([
      fetchLatestRun(resolved),
      fetchLatestSuccessRun(resolved),
      fetchOpenTrackingIssue(resolved).catch((err) => {
        // Non-fatal: tracking issue lookup failing shouldn't blank the
        // whole panel — log and continue with the rest of the summary.
        logger.warn('Failed to look up live billing-health tracking issue', {
          error: String(err),
        });
        return null;
      }),
    ]);

    let latestSuccess: LiveBillingHealthSuccessSummary | null = null;
    if (latestSuccessRun) {
      const artifact = await fetchArtifactForRun(resolved, latestSuccessRun.id).catch((err) => {
        logger.warn('Failed to look up artifact for latest successful run', {
          runId: latestSuccessRun.id,
          error: String(err),
        });
        return null;
      });
      latestSuccess = {
        ...toRunSummary(latestSuccessRun),
        artifactId: artifact?.id ?? null,
        artifactExpired: artifact?.expired ?? false,
        artifactSizeInBytes: artifact?.size_in_bytes ?? null,
        screenshotAvailable: Boolean(artifact && !artifact.expired),
      };
    }

    return {
      configured: true,
      workflowHtmlUrl,
      trackingIssueLabelSearchUrl,
      latestRun: latestRun ? toRunSummary(latestRun) : null,
      latestSuccess,
      openTrackingIssue: openIssue
        ? {
            number: openIssue.number,
            htmlUrl: openIssue.html_url,
            title: openIssue.title,
            updatedAt: openIssue.updated_at,
          }
        : null,
      error: null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error('Failed to load live billing-health summary from GitHub', {
      error: String(err),
    });
    return {
      configured: true,
      workflowHtmlUrl,
      trackingIssueLabelSearchUrl,
      latestRun: null,
      latestSuccess: null,
      openTrackingIssue: null,
      error: (err as Error).message,
      fetchedAt: new Date().toISOString(),
    };
  }
}

export async function getLiveBillingHealthSummary(options?: {
  forceRefresh?: boolean;
}): Promise<LiveBillingHealthSummary> {
  const cfg = resolveConfig();
  const ttl =
    'configured' in cfg && cfg.configured === false
      ? DEFAULT_CACHE_TTL_MS
      : (cfg as ResolvedConfig).cacheTtlMs;
  const now = Date.now();
  if (!options?.forceRefresh && summaryCache && summaryCache.expiresAt > now) {
    return summaryCache.value;
  }
  if (inFlightSummary) {
    return inFlightSummary;
  }
  inFlightSummary = loadSummaryUncached()
    .then((value) => {
      summaryCache = { value, expiresAt: Date.now() + ttl };
      return value;
    })
    .finally(() => {
      inFlightSummary = null;
    });
  return inFlightSummary;
}

async function downloadAndExtractScreenshot(
  cfg: ResolvedConfig,
  artifactId: number,
): Promise<CachedScreenshot | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`
    + `/actions/artifacts/${artifactId}/zip`;
  const res = await fetch(url, { headers: buildHeaders(cfg.token), redirect: 'follow' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GitHub artifact download ${res.status} for ${url}: ${body.slice(0, 200)}`,
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(Buffer.from(arrayBuffer));
  const targetSuffix = `/${cfg.successScreenshot}`;
  // The CI workflow uploads `.ci-logs/` so the screenshot is stored at
  // `screenshots/platform-admin-billing-health-live-success.png` inside
  // the zip. We accept any path ending with the configured filename so
  // a future tweak to the upload-artifact `path` doesn't silently break
  // the panel.
  let entry = zip.file(cfg.successScreenshot);
  if (!entry) {
    const match = Object.values(zip.files).find(
      (f) => !f.dir && (f.name === cfg.successScreenshot || f.name.endsWith(targetSuffix)),
    );
    if (match) entry = match;
  }
  if (!entry) {
    logger.warn('Live billing-health artifact zip did not contain the success screenshot', {
      artifactId,
      expectedName: cfg.successScreenshot,
      entries: Object.keys(zip.files).slice(0, 20),
    });
    return null;
  }
  const buffer = await entry.async('nodebuffer');
  return { artifactId, buffer, contentType: 'image/png' };
}

export async function getLatestSuccessScreenshot(): Promise<CachedScreenshot | null> {
  const cfg = resolveConfig();
  if ('configured' in cfg && cfg.configured === false) {
    return null;
  }
  const resolved = cfg as ResolvedConfig;
  const summary = await getLiveBillingHealthSummary();
  const artifactId = summary.latestSuccess?.artifactId ?? null;
  if (!artifactId || summary.latestSuccess?.artifactExpired) {
    return null;
  }
  const now = Date.now();
  if (
    screenshotCache
    && screenshotCache.value.artifactId === artifactId
    && screenshotCache.expiresAt > now
  ) {
    return screenshotCache.value;
  }
  const downloaded = await downloadAndExtractScreenshot(resolved, artifactId);
  if (!downloaded) return null;
  screenshotCache = { value: downloaded, expiresAt: Date.now() + resolved.cacheTtlMs };
  return downloaded;
}

async function loadFailureScreenshotLinksUncached(): Promise<
  LiveBillingHealthFailureScreenshotLinks | null
> {
  const cfg = resolveConfig();
  if ('configured' in cfg && cfg.configured === false) {
    return null;
  }
  const resolved = cfg as ResolvedConfig;
  try {
    const failureRun = await fetchLatestFailureRun(resolved);
    if (!failureRun) return null;
    const artifact = await fetchArtifactForRun(resolved, failureRun.id).catch((err) => {
      logger.warn('Failed to look up artifact for latest failure run', {
        runId: failureRun.id,
        error: String(err),
      });
      return null;
    });
    const artifactExpired = artifact?.expired ?? false;
    const artifactPageUrl =
      artifact && !artifactExpired
        ? `https://github.com/${resolved.owner}/${resolved.repo}/actions/runs/${failureRun.id}/artifacts/${artifact.id}`
        : null;
    return {
      workflowRunHtmlUrl: failureRun.html_url,
      artifactPageUrl,
      artifactExpired,
      failureRunUpdatedAt: failureRun.updated_at,
    };
  } catch (err) {
    // Best-effort: a GitHub API hiccup must NOT swallow the underlying
    // ops alert. Callers (the Stripe drift Slack post + the CI body
    // builder) treat `null` as "no link to embed" and continue.
    logger.warn('Failed to load failure-screenshot links from GitHub', {
      error: String(err),
    });
    return null;
  }
}

/**
 * Returns deep links to the most recent live billing-health failure
 * screenshot artifact, or `null` when the GitHub integration is
 * unconfigured / the workflow has never failed / the lookup itself
 * blew up.
 *
 * Cached for the same TTL as `getLiveBillingHealthSummary` so a burst
 * of drift alerts (the in-process scheduler can fire alongside the
 * nightly CI workflow) doesn't spray the GitHub API.
 */
export async function getLatestFailureScreenshotLinks(options?: {
  forceRefresh?: boolean;
}): Promise<LiveBillingHealthFailureScreenshotLinks | null> {
  const cfg = resolveConfig();
  const ttl =
    'configured' in cfg && cfg.configured === false
      ? DEFAULT_CACHE_TTL_MS
      : (cfg as ResolvedConfig).cacheTtlMs;
  const now = Date.now();
  if (!options?.forceRefresh && failureLinksCache && failureLinksCache.expiresAt > now) {
    return failureLinksCache.value;
  }
  if (inFlightFailureLinks) {
    return inFlightFailureLinks;
  }
  inFlightFailureLinks = loadFailureScreenshotLinksUncached()
    .then((value) => {
      failureLinksCache = { value, expiresAt: Date.now() + ttl };
      return value;
    })
    .finally(() => {
      inFlightFailureLinks = null;
    });
  return inFlightFailureLinks;
}

/** Test-only: clear in-process caches between assertions. */
export function __resetLiveBillingHealthCachesForTests(): void {
  summaryCache = null;
  screenshotCache = null;
  inFlightSummary = null;
  failureLinksCache = null;
  inFlightFailureLinks = null;
}
