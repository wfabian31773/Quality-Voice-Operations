import { createLogger } from '../core/logger';

const logger = createLogger('SLACK_WEBHOOK');

const REQUEST_TIMEOUT_MS = 10_000;

export interface SlackWebhookMessage {
  text: string;
  blocks?: unknown[];
}

export interface SlackWebhookResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

export function getOpsSlackWebhookUrl(): string | null {
  const url = (
    process.env.OPS_SLACK_WEBHOOK_URL ??
    process.env.SLACK_WEBHOOK_URL ??
    process.env.SLACK_WEBHOOK ??
    ''
  ).trim();
  return url || null;
}

export async function postToOpsSlackWebhook(
  message: SlackWebhookMessage,
): Promise<SlackWebhookResult> {
  const url = getOpsSlackWebhookUrl();
  if (!url) {
    logger.debug('Ops Slack webhook URL not configured — skipping Slack notification');
    return { success: false, skipped: true };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('Slack webhook returned non-2xx', {
        status: res.status,
        body: body.slice(0, 200),
      });
      return {
        success: false,
        error: `Slack webhook HTTP ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    return { success: true };
  } catch (err) {
    clearTimeout(timeoutId);
    const error = err instanceof Error ? err.message : String(err);
    logger.warn('Slack webhook request failed', { error });
    return { success: false, error };
  }
}
