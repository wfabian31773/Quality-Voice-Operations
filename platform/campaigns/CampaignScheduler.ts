import { createLogger } from '../core/logger';
import {
  getRunningCampaigns,
  getNextPendingContact,
  updateContactStatus,
  revertContactToPending,
  checkCampaignCompletion,
  registerCallSid,
  getActiveDialingCount,
  getTenantActiveDialingCount,
  getTenantMaxConcurrent,
  incrementQuietHoursSkips,
} from './CampaignService';
import { dialContact } from './OutboundDialer';
import { isContactOnDnc } from './ComplianceService';
import { evaluateQuietHours, type QuietHoursConfig } from './QuietHours';
import { resolveCampaignCallerId } from '../telephony/TrustedCallerService';

const logger = createLogger('CAMPAIGN_SCHEDULER');

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 2;

export interface CampaignSchedulerConfig {
  pollIntervalMs?: number;
  outboundCallbackBaseUrl: string;
  statusCallbackUrl: string;
}

/**
 * Coarse pre-check used to skip scheduling work entirely when *no* contact
 * could possibly be dialable (e.g. it is 3am in every US timezone). When the
 * campaign has `respectContactTimezone` enabled (the default) we cannot
 * answer that question without a contact, so we always return true and let
 * the per-contact check inside the dial loop do the real work.
 */
function couldAnyContactBeInWindow(config: Record<string, unknown>): boolean {
  const respectContact = (config as { respectContactTimezone?: boolean }).respectContactTimezone !== false;
  if (respectContact) return true;
  const decision = evaluateQuietHours('', config as QuietHoursConfig);
  return decision.allowed;
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
        if (!couldAnyContactBeInWindow(campaign.config)) {
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

        const maxConcurrent = (campaign.config.maxConcurrent as number) ?? (campaign.config.maxConcurrentCalls as number) ?? DEFAULT_MAX_CONCURRENT;
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
        let consecutiveQuietHourSkips = 0;
        let quietHourSkipsThisTick = 0;
        // Track contacts we already saw and skipped within this tick so the
        // SKIP LOCKED query doesn't immediately hand the same row back.
        const tickSkippedIds: string[] = [];
        for (let slot = 0; slot < availableSlots; slot++) {
          const contact = await getNextPendingContact(
            campaign.tenantId,
            campaign.id,
            maxAttempts,
            retryDelayMinutes,
            tickSkippedIds,
          );
          if (!contact) break;

          const quietHours = evaluateQuietHours(contact.phoneNumber, campaign.config as QuietHoursConfig);
          if (!quietHours.allowed) {
            await revertContactToPending(campaign.tenantId, contact.id);
            tickSkippedIds.push(contact.id);
            quietHourSkipsThisTick++;
            logger.debug('Contact skipped — outside quiet hours window', {
              tenantId: campaign.tenantId,
              campaignId: campaign.id,
              contactId: contact.id,
              timezone: quietHours.timezone,
              reason: quietHours.reason,
            });
            consecutiveQuietHourSkips++;
            // Stop after a streak of skips so we don't scan the whole
            // campaign roster in a single tick when the entire batch happens
            // to share an off-hours timezone.
            if (consecutiveQuietHourSkips >= 5) break;
            // Re-attempt this slot; we deliberately don't increment `slot`
            // here because the skipped contact never consumed a dial budget.
            slot--;
            continue;
          }
          consecutiveQuietHourSkips = 0;

          const onDnc = await isContactOnDnc(campaign.tenantId, contact.phoneNumber);
          if (onDnc) {
            await updateContactStatus(campaign.tenantId, contact.id, 'opted_out', undefined, 'DNC list match');
            logger.info('Contact skipped — on DNC list', {
              tenantId: campaign.tenantId,
              campaignId: campaign.id,
              contactId: contact.id,
            });
            continue;
          }

          const verifiedCallerIdCfg = (campaign.config.verifiedCallerId as string | undefined) ?? null;
          let fromNumber: string | undefined;
          if (verifiedCallerIdCfg) {
            const verified = await resolveCampaignCallerId(campaign.tenantId, verifiedCallerIdCfg);
            if (!verified) {
              logger.warn('Campaign references missing/unverified caller ID — pausing contact', {
                tenantId: campaign.tenantId,
                campaignId: campaign.id,
                contactId: contact.id,
                verifiedCallerId: verifiedCallerIdCfg,
              });
              await updateContactStatus(
                campaign.tenantId,
                contact.id,
                'failed',
                undefined,
                'Verified caller ID is missing or no longer verified',
                'failed',
              );
              continue;
            }
            fromNumber = verified.phoneNumber;
          }

          const result = await dialContact({
            tenantId: campaign.tenantId,
            campaignId: campaign.id,
            contactId: contact.id,
            agentId: campaign.agentId,
            phoneNumber: contact.phoneNumber,
            callbackUrl: `${this.config.outboundCallbackBaseUrl}/twilio/outbound`,
            statusCallbackUrl: this.config.statusCallbackUrl,
            fromNumber,
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
        if (quietHourSkipsThisTick > 0) {
          await incrementQuietHoursSkips(
            campaign.tenantId,
            campaign.id,
            quietHourSkipsThisTick,
          );
        }
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
