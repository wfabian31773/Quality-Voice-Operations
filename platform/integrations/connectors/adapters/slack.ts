import { createLogger } from '../../../core/logger';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('SLACK_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;
const SLACK_API = 'https://slack.com/api';

export class SlackConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const botToken = config.credentials.bot_token ?? config.credentials.access_token ?? '';
    const channel = config.credentials.channel_id ?? config.credentials.channel ?? '';

    if (!botToken) {
      logger.error('Missing Slack bot token', { tenantId });
      return { success: false, error: 'Slack connector not configured: missing bot_token' };
    }

    if (!channel) {
      logger.error('Missing Slack channel', { tenantId });
      return { success: false, error: 'Slack connector not configured: missing channel_id' };
    }

    switch (payload.type) {
      case 'call.completed':
        return this.sendCallSummary(tenantId, botToken, channel, payload);
      case 'call.missed':
        return this.sendMissedCallAlert(tenantId, botToken, channel, payload);
      case 'appointment.booked':
        return this.sendAppointmentNotification(tenantId, botToken, channel, payload);
      case 'ticket.created':
        return this.sendTicketNotification(tenantId, botToken, channel, payload);
      case 'sms.sent':
        return this.sendSmsNotification(tenantId, botToken, channel, payload);
      default:
        return { success: false, error: `Slack adapter does not handle event: ${payload.type}` };
    }
  }

  private async sendCallSummary(
    tenantId: TenantId,
    botToken: string,
    channel: string,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const callerPhone = (payload.callerPhone as string) ?? 'Unknown';
    const duration = (payload.durationSeconds as number) ?? 0;
    const summary = (payload.summary as string) ?? 'No summary available';
    const agentName = (payload.agentName as string) ?? 'AI Agent';
    const resolution = (payload.resolution as string) ?? 'completed';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':phone: Call Completed', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Caller:*\n${callerPhone}` },
          { type: 'mrkdwn', text: `*Duration:*\n${this.formatDuration(duration)}` },
          { type: 'mrkdwn', text: `*Agent:*\n${agentName}` },
          { type: 'mrkdwn', text: `*Resolution:*\n${resolution}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Summary:*\n${summary}` },
      },
      { type: 'divider' },
    ];

    return this.postMessage(tenantId, botToken, channel, blocks, `Call completed from ${callerPhone}`);
  }

  private async sendMissedCallAlert(
    tenantId: TenantId,
    botToken: string,
    channel: string,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const callerPhone = (payload.callerPhone as string) ?? 'Unknown';
    const reason = (payload.reason as string) ?? 'Call ended without resolution';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':warning: Missed Call Alert', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Caller:*\n${callerPhone}` },
          { type: 'mrkdwn', text: `*Reason:*\n${reason}` },
        ],
      },
      { type: 'divider' },
    ];

    return this.postMessage(tenantId, botToken, channel, blocks, `Missed call from ${callerPhone}`);
  }

  private async sendAppointmentNotification(
    tenantId: TenantId,
    botToken: string,
    channel: string,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const summary = (payload.summary as string) ?? 'New appointment';
    const appointmentDate = (payload.appointmentDate as string) ?? '';
    const appointmentTime = (payload.appointmentTime as string) ?? '';
    const callerPhone = (payload.callerPhone as string) ?? 'Unknown';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':calendar: Appointment Booked', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Patient/Client:*\n${callerPhone}` },
          { type: 'mrkdwn', text: `*Date:*\n${appointmentDate || 'TBD'}` },
          { type: 'mrkdwn', text: `*Time:*\n${appointmentTime || 'TBD'}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Details:*\n${summary}` },
      },
      { type: 'divider' },
    ];

    return this.postMessage(tenantId, botToken, channel, blocks, `Appointment booked: ${summary}`);
  }

  private async sendTicketNotification(
    tenantId: TenantId,
    botToken: string,
    channel: string,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const ticketNumber = (payload.ticketNumber as string) ?? '';
    const reason = (payload.reason as string) ?? (payload.reasonForCalling as string) ?? '';
    const patientName = (payload.patientFullName as string) ?? 'Unknown';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':ticket: Ticket Created', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Ticket:*\n${ticketNumber || 'N/A'}` },
          { type: 'mrkdwn', text: `*Name:*\n${patientName}` },
          { type: 'mrkdwn', text: `*Reason:*\n${reason || 'Not specified'}` },
        ],
      },
      { type: 'divider' },
    ];

    return this.postMessage(tenantId, botToken, channel, blocks, `Ticket created: ${ticketNumber}`);
  }

  private async sendSmsNotification(
    tenantId: TenantId,
    botToken: string,
    channel: string,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const to = (payload.to as string) ?? 'Unknown';
    const body = (payload.body as string) ?? '';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':speech_balloon: SMS Sent', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*To:*\n${to}` },
          { type: 'mrkdwn', text: `*Message:*\n${body.slice(0, 200)}` },
        ],
      },
      { type: 'divider' },
    ];

    return this.postMessage(tenantId, botToken, channel, blocks, `SMS sent to ${to}`);
  }

  private async postMessage(
    tenantId: TenantId,
    botToken: string,
    channel: string,
    blocks: unknown[],
    fallbackText: string,
  ): Promise<ConnectorResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${SLACK_API}/chat.postMessage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, blocks, text: fallbackText }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.error('Slack API HTTP error', { tenantId, status: res.status });
        return { success: false, error: `Slack API error ${res.status}: ${text.slice(0, 200)}` };
      }

      const data = await res.json() as { ok: boolean; ts?: string; error?: string };
      if (!data.ok) {
        logger.error('Slack API returned error', { tenantId, error: data.error });
        return { success: false, error: `Slack error: ${data.error}` };
      }

      logger.info('Slack message sent', { tenantId, ts: data.ts });
      return {
        success: true,
        externalId: data.ts,
        meta: { messageTs: data.ts, channel, provider: 'slack' },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Slack request failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  }
}
