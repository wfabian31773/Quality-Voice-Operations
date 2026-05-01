/**
 * Covers the small GitHub-API client behind the Platform Admin "Live
 * billing-health screenshot" card:
 *   - returns `configured: false` when env vars are missing (so the
 *     panel hides the card on dev / preview hosts)
 *   - happy-path: stitches together latest run + latest success +
 *     artifact metadata + open tracking issue
 *   - failure-path: surfaces the open `billing-health-live-drift`
 *     tracking issue (link the panel renders next to the red dot)
 *   - graceful error: GitHub 5xx is swallowed into `summary.error` so
 *     the panel doesn't blank out
 *   - screenshot extraction: pulls the success PNG out of the artifact
 *     zip (matches both root and nested paths so an upload-artifact
 *     `path:` tweak doesn't silently break the panel)
 *   - cache: a second call inside the TTL doesn't re-hit GitHub
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  __resetLiveBillingHealthCachesForTests,
  getLatestSuccessScreenshot,
  getLiveBillingHealthSummary,
} from '../../platform/billing/githubLiveBillingHealthArtifact';

const ORIGINAL_ENV = { ...process.env };

function setEnv() {
  process.env.GITHUB_REPOSITORY = 'qvo-org/qvo';
  process.env.GITHUB_TOKEN = 'ghp_fake_test_token';
  delete process.env.GITHUB_BILLING_HEALTH_WORKFLOW_FILE;
  delete process.env.GITHUB_BILLING_HEALTH_ARTIFACT_NAME;
  delete process.env.GITHUB_BILLING_HEALTH_SUCCESS_SCREENSHOT;
  delete process.env.GITHUB_BILLING_HEALTH_DRIFT_LABEL;
  delete process.env.GITHUB_BILLING_HEALTH_CACHE_TTL_MS;
}

function unsetEnv() {
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_TOKEN;
}

interface FetchExpectation {
  match: (url: string) => boolean;
  status?: number;
  body?: unknown;
  arrayBuffer?: () => ArrayBuffer | Promise<ArrayBuffer>;
  contentType?: string;
}

function installFetchMock(expectations: FetchExpectation[]): {
  calls: string[];
  fetch: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const exp = expectations.find((e) => e.match(url));
    if (!exp) {
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }
    const status = exp.status ?? 200;
    const ok = status >= 200 && status < 300;
    const responseBody = exp.body ?? {};
    return {
      ok,
      status,
      headers: { get: (_: string) => exp.contentType ?? 'application/json' },
      text: async () => JSON.stringify(responseBody),
      json: async () => responseBody,
      arrayBuffer: async () => {
        if (exp.arrayBuffer) return exp.arrayBuffer();
        return new ArrayBuffer(0);
      },
    } as unknown as Response;
  });
  globalThis.fetch = fetchFn as unknown as typeof fetch;
  return { calls, fetch: fetchFn };
}

beforeEach(() => {
  __resetLiveBillingHealthCachesForTests();
  setEnv();
});

afterEach(() => {
  __resetLiveBillingHealthCachesForTests();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('getLiveBillingHealthSummary', () => {
  it('returns configured:false when GITHUB_REPOSITORY is missing', async () => {
    unsetEnv();
    const summary = await getLiveBillingHealthSummary();
    expect(summary.configured).toBe(false);
    expect(summary.unavailableReason).toMatch(/GITHUB_REPOSITORY/);
    expect(summary.latestRun).toBeNull();
    expect(summary.latestSuccess).toBeNull();
  });

  it('returns configured:false when GITHUB_REPOSITORY is malformed', async () => {
    process.env.GITHUB_REPOSITORY = 'not-a-slug';
    process.env.GITHUB_TOKEN = 'ghp_fake_test_token';
    const summary = await getLiveBillingHealthSummary();
    expect(summary.configured).toBe(false);
    expect(summary.unavailableReason).toMatch(/owner\/repo/);
  });

  it('stitches latest run, latest success + artifact, and open tracking issue', async () => {
    const latestRun = {
      id: 999,
      conclusion: 'failure',
      status: 'completed',
      html_url: 'https://github.com/qvo-org/qvo/actions/runs/999',
      run_started_at: '2026-04-30T10:00:00Z',
      updated_at: '2026-04-30T10:05:00Z',
      head_sha: 'sha-fail',
      head_branch: 'main',
      event: 'schedule',
    };
    const latestSuccessRun = {
      id: 700,
      conclusion: 'success',
      status: 'completed',
      html_url: 'https://github.com/qvo-org/qvo/actions/runs/700',
      run_started_at: '2026-04-29T04:37:00Z',
      updated_at: '2026-04-29T04:40:00Z',
      head_sha: 'sha-ok',
      head_branch: 'main',
      event: 'schedule',
    };
    const artifact = {
      id: 12345,
      name: 'billing-health-live-stripe-artifacts',
      size_in_bytes: 4096,
      expired: false,
      archive_download_url:
        'https://api.github.com/repos/qvo-org/qvo/actions/artifacts/12345/zip',
    };
    const openIssue = {
      number: 42,
      html_url: 'https://github.com/qvo-org/qvo/issues/42',
      title: 'Live billing-health tile is failing against the real Stripe verifier',
      updated_at: '2026-04-30T10:05:00Z',
    };

    const { calls } = installFetchMock([
      {
        match: (u) => u.includes('/runs?per_page=1') && !u.includes('status=success'),
        body: { workflow_runs: [latestRun] },
      },
      {
        match: (u) => u.includes('status=success&per_page=1'),
        body: { workflow_runs: [latestSuccessRun] },
      },
      {
        match: (u) => u.includes('/runs/700/artifacts'),
        body: { artifacts: [artifact, { id: 99, name: 'unrelated', expired: false }] },
      },
      {
        match: (u) => u.includes('/issues?state=open'),
        body: [openIssue],
      },
    ]);

    const summary = await getLiveBillingHealthSummary();
    expect(summary.configured).toBe(true);
    expect(summary.error).toBeNull();
    expect(summary.workflowHtmlUrl).toBe(
      'https://github.com/qvo-org/qvo/actions/workflows/billing-health-live-stripe.yml',
    );
    expect(summary.trackingIssueLabelSearchUrl).toContain(
      'label%3Abilling-health-live-drift',
    );
    expect(summary.latestRun?.id).toBe(999);
    expect(summary.latestRun?.conclusion).toBe('failure');
    expect(summary.latestSuccess?.id).toBe(700);
    expect(summary.latestSuccess?.artifactId).toBe(12345);
    expect(summary.latestSuccess?.screenshotAvailable).toBe(true);
    expect(summary.openTrackingIssue?.number).toBe(42);
    expect(summary.openTrackingIssue?.htmlUrl).toBe(openIssue.html_url);
    expect(calls.length).toBe(4);
  });

  it('caches results between calls inside the TTL window', async () => {
    const { calls } = installFetchMock([
      {
        match: (u) => u.includes('/runs?per_page=1') && !u.includes('status=success'),
        body: { workflow_runs: [] },
      },
      {
        match: (u) => u.includes('status=success&per_page=1'),
        body: { workflow_runs: [] },
      },
      {
        match: (u) => u.includes('/issues?state=open'),
        body: [],
      },
    ]);

    await getLiveBillingHealthSummary();
    const firstCallCount = calls.length;
    await getLiveBillingHealthSummary();
    expect(calls.length).toBe(firstCallCount);
  });

  it('captures GitHub errors into summary.error without blanking metadata', async () => {
    installFetchMock([
      {
        match: () => true,
        status: 500,
        body: { message: 'kaboom' },
      },
    ]);
    const summary = await getLiveBillingHealthSummary();
    expect(summary.configured).toBe(true);
    expect(summary.error).toMatch(/500/);
    expect(summary.workflowHtmlUrl).toBeTruthy();
  });

  it('keeps the rest of the summary when the tracking-issue lookup alone fails', async () => {
    const latestRun = {
      id: 1,
      conclusion: 'success',
      status: 'completed',
      html_url: 'https://github.com/qvo-org/qvo/actions/runs/1',
      run_started_at: '2026-04-30T10:00:00Z',
      updated_at: '2026-04-30T10:05:00Z',
      head_sha: 'sha',
      head_branch: 'main',
      event: 'schedule',
    };
    installFetchMock([
      {
        match: (u) => u.includes('/runs?per_page=1') && !u.includes('status=success'),
        body: { workflow_runs: [latestRun] },
      },
      {
        match: (u) => u.includes('status=success&per_page=1'),
        body: { workflow_runs: [latestRun] },
      },
      {
        match: (u) => u.includes('/runs/1/artifacts'),
        body: { artifacts: [] },
      },
      {
        match: (u) => u.includes('/issues?state=open'),
        status: 502,
        body: { message: 'bad gateway' },
      },
    ]);
    const summary = await getLiveBillingHealthSummary();
    expect(summary.configured).toBe(true);
    expect(summary.error).toBeNull();
    expect(summary.openTrackingIssue).toBeNull();
    expect(summary.latestRun?.id).toBe(1);
  });

  it('skips pull requests when scanning the issues endpoint', async () => {
    const latestRun = {
      id: 1,
      conclusion: 'failure',
      status: 'completed',
      html_url: 'https://github.com/qvo-org/qvo/actions/runs/1',
      run_started_at: '2026-04-30T10:00:00Z',
      updated_at: '2026-04-30T10:05:00Z',
      head_sha: 'sha',
      head_branch: 'main',
      event: 'schedule',
    };
    const realIssue = {
      number: 7,
      html_url: 'https://github.com/qvo-org/qvo/issues/7',
      title: 'real issue',
      updated_at: '2026-04-30T10:05:00Z',
    };
    installFetchMock([
      {
        match: (u) => u.includes('/runs?per_page=1') && !u.includes('status=success'),
        body: { workflow_runs: [latestRun] },
      },
      {
        match: (u) => u.includes('status=success&per_page=1'),
        body: { workflow_runs: [] },
      },
      {
        match: (u) => u.includes('/issues?state=open'),
        body: [
          { ...realIssue, number: 6, pull_request: { url: 'pr' } },
          realIssue,
        ],
      },
    ]);
    const summary = await getLiveBillingHealthSummary();
    expect(summary.openTrackingIssue?.number).toBe(7);
  });
});

describe('getLatestSuccessScreenshot', () => {
  it('returns null when not configured', async () => {
    unsetEnv();
    const result = await getLatestSuccessScreenshot();
    expect(result).toBeNull();
  });

  it('extracts the success PNG from a nested zip path', async () => {
    const zip = new JSZip();
    zip.file('screenshots/platform-admin-billing-health-live-success.png', 'PNGDATA');
    zip.file('platform-dev.log', 'log');
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const latestSuccessRun = {
      id: 700,
      conclusion: 'success',
      status: 'completed',
      html_url: 'https://github.com/qvo-org/qvo/actions/runs/700',
      run_started_at: '2026-04-29T04:37:00Z',
      updated_at: '2026-04-29T04:40:00Z',
      head_sha: 'sha-ok',
      head_branch: 'main',
      event: 'schedule',
    };
    const artifact = {
      id: 4242,
      name: 'billing-health-live-stripe-artifacts',
      size_in_bytes: zipBuffer.byteLength,
      expired: false,
      archive_download_url:
        'https://api.github.com/repos/qvo-org/qvo/actions/artifacts/4242/zip',
    };

    installFetchMock([
      {
        match: (u) => u.includes('/runs?per_page=1') && !u.includes('status=success'),
        body: { workflow_runs: [latestSuccessRun] },
      },
      {
        match: (u) => u.includes('status=success&per_page=1'),
        body: { workflow_runs: [latestSuccessRun] },
      },
      {
        match: (u) => u.includes('/runs/700/artifacts'),
        body: { artifacts: [artifact] },
      },
      {
        match: (u) => u.includes('/issues?state=open'),
        body: [],
      },
      {
        match: (u) => u.includes('/actions/artifacts/4242/zip'),
        arrayBuffer: () =>
          zipBuffer.buffer.slice(
            zipBuffer.byteOffset,
            zipBuffer.byteOffset + zipBuffer.byteLength,
          ) as ArrayBuffer,
        contentType: 'application/zip',
      },
    ]);

    const result = await getLatestSuccessScreenshot();
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe('image/png');
    expect(result?.buffer.toString('utf8')).toBe('PNGDATA');
  });

  it('returns null when the artifact zip lacks the success screenshot', async () => {
    const zip = new JSZip();
    zip.file('screenshots/platform-admin-billing-health-live-failure.png', 'fail');
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const latestSuccessRun = {
      id: 800,
      conclusion: 'success',
      status: 'completed',
      html_url: 'https://github.com/qvo-org/qvo/actions/runs/800',
      run_started_at: '2026-04-29T04:37:00Z',
      updated_at: '2026-04-29T04:40:00Z',
      head_sha: 'sha-ok',
      head_branch: 'main',
      event: 'schedule',
    };
    const artifact = {
      id: 8080,
      name: 'billing-health-live-stripe-artifacts',
      size_in_bytes: zipBuffer.byteLength,
      expired: false,
      archive_download_url: 'https://api.github.com/whatever',
    };

    installFetchMock([
      {
        match: (u) => u.includes('/runs?per_page=1') && !u.includes('status=success'),
        body: { workflow_runs: [latestSuccessRun] },
      },
      {
        match: (u) => u.includes('status=success&per_page=1'),
        body: { workflow_runs: [latestSuccessRun] },
      },
      {
        match: (u) => u.includes('/runs/800/artifacts'),
        body: { artifacts: [artifact] },
      },
      {
        match: (u) => u.includes('/issues?state=open'),
        body: [],
      },
      {
        match: (u) => u.includes('/actions/artifacts/8080/zip'),
        arrayBuffer: () =>
          zipBuffer.buffer.slice(
            zipBuffer.byteOffset,
            zipBuffer.byteOffset + zipBuffer.byteLength,
          ) as ArrayBuffer,
      },
    ]);

    const result = await getLatestSuccessScreenshot();
    expect(result).toBeNull();
  });
});
