import { createLogger } from '../core/logger';
import {
  getRunningCampaigns,
  getNextPendingContact,
  updateContactStatus,
  checkCampaignCompletion,
  registerCallSid,
  getActiveDialingCount,
  getTenantActiveDialingCount,
  getTenantMaxConcurrent,
} from './CampaignService';
import { dialContact } from './OutboundDialer';
import { isOnDnc } from './DncService';

const logger = createLogger('CAMPAIGN_SCHEDULER');

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 2;

export interface CampaignSchedulerConfig {
  pollIntervalMs?: number;
  outboundCallbackBaseUrl: string;
  statusCallbackUrl: string;
}

function isWithinCallWindow(config: Record<string, unknown>): boolean {
  const timezone = (config.timezone as string) || 'America/Chicago';
  const windowStart = (config.callWindowStart as string) || '09:00';
  const windowEnd = (config.callWindowEnd as string) || '18:00';
  const daysOfWeek = (config.daysOfWeek as number[]) || [1, 2, 3, 4, 5];

  try {
    const now = new Date();
    const localStr = now.toLocaleString('en-US', { timeZone: timezone });
    const localDate = new Date(localStr);

    const dayOfWeek = localDate.getDay();
    if (!daysOfWeek.includes(dayOfWeek)) return false;

    const hours = localDate.getHours();
    const minutes = localDate.getMinutes();
    const currentMinutes = hours * 60 + minutes;

    const [startH, startM] = windowStart.split(':').map(Number);
    const [endH, endM] = windowEnd.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } catch (err) {
    logger.warn('Failed to check call window timezone', { timezone, error: String(err) });
    return true;
  }
}

export class CampaignScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly config: Required<CampaignSchedulerConfig>;

  constructor(config: CampaignSchedulerConfig) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      outboundCallbackBaseUrl: config.outboundCallbackBaseUrl,
      statusCallbackUrl: config.statusCallbackUrl,
    };
  }

  start(): void {
    if (this.timer) return;
    logger.info('Campaign scheduler started', { pollIntervalMs: this.config.pollIntervalMs });
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error('Campaign scheduler tick error', { error: String(err) });
      });
    }, this.config.pollIntervalMs);
    this.tick().catch((err) => {
      logger.error('Campaign scheduler initial tick error', { error: String(err) });
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Campaign scheduler stopped');
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const campaigns = await getRunningCampaigns();

      const tenantDialingCounts = new Map<string, number>();
      const tenantMaxConcurrentCache = new Map<string, number>();

      for (const campaign of campaigns) {
        if (!isWithinCallWindow(campaign.config)) {
          logger.debug('Campaign outside call window — skipping', {
            campaignId: campaign.id,
            tenantId: campaign.tenantId,
          });
          continue;
        }

        if (!tenantDialingCounts.has(campaign.tenantId)) {
          tenantDialingCounts.set(
            campaign.tenantId,
            await getTenantActiveDialingCount(campaign.tenantId),
          );
          tenantMaxConcurrentCache.set(
            campaign.tenantId,
            await getTenantMaxConcurrent(campaign.tenantId),
          );
        }
        const tenantActive = tenantDialingCounts.get(campaign.tenantId)!;
        const tenantMaxConcurrent = tenantMaxConcurrentCache.get(campaign.tenantId)!;
        const tenantAvailable = tenantMaxConcurrent - tenantActive;
        if (tenantAvailable <= 0) {
          logger.debug('Tenant at concurrency limit — skipping', {
            tenantId: campaign.tenantId,
            active: tenantActive,
            max: tenantMaxConcurrent,
          });
          continue;
        }

        const maxConcurrent = (campaign.config.maxConcurrentCalls as number) ?? DEFAULT_MAX_CONCURRENT;
        const maxAttempts = (campaign.config.maxAttempts as number) ?? 3;
        const retryDelayMinutes = (campaign.config.retryDelayMinutes as number) ?? 30;

        const campaignActive = await getActiveDialingCount(campaign.tenantId, campaign.id);
        const campaignAvailable = maxConcurrent - campaignActive;
        const availableSlots = Math.min(campaignAvailable, tenantAvailable);
        if (availableSlots <= 0) {
          logger.debug('Campaign at concurrency limit — skipping', {
            campaignId: campaign.id,
            active: campaignActive,
            max: maxConcurrent,
          });
          continue;
        }

        let dispatched = 0;
        for (let slot = 0; slot < availableSlots; slot++) {
          const contact = await getNextPendingContact(campaign.tenantId, campaign.id, maxAttempts, retryDelayMinutes);
          if (!contact) break;

          const onDnc = await isOnDnc(campaign.tenantId, contact.phoneNumber);
          if (onDnc) {
            await updateContactStatus(campaign.tenantId, contact.id, 'opted_out', undefined, 'DNC list match');
            logger.info('Contact skipped — on DNC list', {
              tenantId: campaign.tenantId,
              campaignId: campaign.id,
              contactId: contact.id,
            });
            continue;
          }

          const result = await dialContact({
            tenantId: campaign.tenantId,
            campaignId: campaign.id,
            contactId: contact.id,
            agentId: campaign.agentId,
            phoneNumber: contact.phoneNumber,
            callbackUrl: `${this.config.outboundCallbackBaseUrl}/twilio/outbound`,
            statusCallbackUrl: this.config.statusCallbackUrl,
          });

          if (!result.success) {
            const isDncBlock = result.error === 'DNC list match';
            await updateContactStatus(
              campaign.tenantId,
              contact.id,
              isDncBlock ? 'opted_out' : 'failed',
              undefined,
              result.error,
              isDncBlock ? undefined : 'failed',
            );
            if (isDncBlock) {
              logger.info('Contact blocked by OutboundDialer DNC check', {
                tenantId: campaign.tenantId,
                campaignId: campaign.id,
                contactId: contact.id,
              });
            } else {
              logger.warn('Failed to dial contact', {
                tenantId: campaign.tenantId,
                campaignId: campaign.id,
                contactId: contact.id,
                error: result.error,
              });
            }
          } else {
            dispatched++;
            if (result.callSid) {
              await registerCallSid(campaign.tenantId, contact.id, result.callSid);
            }
            logger.info('Contact dialing initiated', {
              tenantId: campaign.tenantId,
              campaignId: campaign.id,
              contactId: contact.id,
              callSid: result.callSid,
            });
          }
        }

        tenantDialingCounts.set(campaign.tenantId, tenantActive + dispatched);
        await checkCampaignCompletion(campaign.tenantId, campaign.id);
      }
    } finally {
      this.running = false;
    }
  }
}

let schedulerInstance: CampaignScheduler | null = null;

export function startCampaignScheduler(config: CampaignSchedulerConfig): CampaignScheduler {
  if (schedulerInstance) {
    schedulerInstance.stop();
  }
  schedulerInstance = new CampaignScheduler(config);
  schedulerInstance.start();
  return schedulerInstance;
}

export function stopCampaignScheduler(): void {
  schedulerInstance?.stop();
  schedulerInstance = null;
}
