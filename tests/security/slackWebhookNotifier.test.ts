import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  postToOpsSlackWebhook,
  getOpsSlackWebhookUrl,
} from '../../platform/messaging/SlackWebhookNotifier';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.OPS_SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getOpsSlackWebhookUrl', () => {
  it('returns null when no webhook env var is configured', () => {
    expect(getOpsSlackWebhookUrl()).toBeNull();
  });

  it('prefers OPS_SLACK_WEBHOOK_URL over generic fallbacks', () => {
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/A';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/B';
    expect(getOpsSlackWebhookUrl()).toBe('https://hooks.slack.com/services/A');
  });

  it('falls back to SLACK_WEBHOOK_URL', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/B';
    expect(getOpsSlackWebhookUrl()).toBe('https://hooks.slack.com/services/B');
  });

  it('falls back to legacy SLACK_WEBHOOK', () => {
    process.env.SLACK_WEBHOOK = 'https://hooks.slack.com/services/C';
    expect(getOpsSlackWebhookUrl()).toBe('https://hooks.slack.com/services/C');
  });
});

describe('postToOpsSlackWebhook', () => {
  it('returns skipped=true and does not call fetch when no URL is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    const result = await postToOpsSlackWebhook({ text: 'hi' });

    expect(result).toEqual({ success: false, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs JSON to the configured webhook and returns success on 2xx', async () => {
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/X';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const result = await postToOpsSlackWebhook({ text: 'hello', blocks: [{ a: 1 }] });

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/X');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ text: 'hello', blocks: [{ a: 1 }] });
  });

  it('returns success=false on non-2xx without throwing', async () => {
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/Y';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    );

    const result = await postToOpsSlackWebhook({ text: 'hello' });

    expect(result.success).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toMatch(/HTTP 500/);
  });

  it('returns success=false on network error without throwing', async () => {
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/Z';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await postToOpsSlackWebhook({ text: 'hello' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
  });
});
