import { createLogger } from '../core/logger';
import { normalizePhone } from '../core/types';
import {
  getCampaign,
  addContacts,
  listCampaigns,
} from '../campaigns/CampaignService';
import type { ToolDefinition, ToolContext } from './registry/types';

const logger = createLogger('TOOL_CREATE_CAMPAIGN');

export interface CreateCampaignContactInput {
  campaignId?: string;
  campaignName?: string;
  phoneNumber: string;
  contactName?: string;
  metadata?: Record<string, unknown>;
}

async function handler(input: unknown, context: ToolContext): Promise<unknown> {
  const { tenantId } = context;
  const args = input as CreateCampaignContactInput;

  if (!args.phoneNumber) {
    return { success: false, message: 'phoneNumber is required.' };
  }

  if (!args.campaignId && !args.campaignName) {
    return { success: false, message: 'Either campaignId or campaignName must be provided.' };
  }

  const normalized = normalizePhone(args.phoneNumber);

  try {
    let campaignId = args.campaignId;

    if (!campaignId && args.campaignName) {
      const { campaigns } = await listCampaigns(tenantId, { limit: 100 });
      const match = campaigns.find(
        (c) => c.name.toLowerCase() === args.campaignName!.toLowerCase(),
      );
      if (!match) {
        return {
          success: false,
          message: `No campaign found with name "${args.campaignName}".`,
        };
      }
      campaignId = match.id;
    }

    const campaign = await getCampaign(tenantId, campaignId!);
    if (!campaign) {
      return { success: false, message: `Campaign ${campaignId} not found.` };
    }

    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      return {
        success: false,
        message: `Campaign "${campaign.name}" is ${campaign.status} and cannot accept new contacts.`,
      };
    }

    const inserted = await addContacts(tenantId, campaignId!, [
      {
        phoneNumber: normalized,
        name: args.contactName,
        metadata: args.metadata,
      },
    ]);

    logger.info('Contact added to campaign', {
      tenantId,
      campaignId,
      phone: `***${normalized.slice(-4)}`,
      inserted,
    });

    return {
      success: true,
      message: inserted > 0
        ? `Contact has been added to campaign "${campaign.name}" for follow-up.`
        : `Contact was already in campaign "${campaign.name}".`,
      campaignId,
      campaignName: campaign.name,
      added: inserted > 0,
    };
  } catch (err) {
    logger.error('create_campaign failed', { tenantId, error: String(err) });
    return { success: false, message: 'Failed to add contact to campaign. Please try again.' };
  }
}

export const createCampaignContactTool: ToolDefinition = {
  name: 'create_campaign',
  description: 'Add a contact to an existing outbound campaign for automated follow-up calls. You must provide either campaignId or campaignName to identify the campaign.',
  inputSchema: {
    type: 'object',
    properties: {
      campaignId: {
        type: 'string',
        description: 'The ID of the campaign to add the contact to. Provide this or campaignName.',
      },
      campaignName: {
        type: 'string',
        description: 'The name of the campaign to add the contact to. Provide this or campaignId.',
      },
      phoneNumber: {
        type: 'string',
        description: 'The phone number of the contact to add.',
      },
      contactName: {
        type: 'string',
        description: 'The name of the contact.',
      },
      metadata: {
        type: 'object',
        description: 'Additional metadata to store with the campaign contact.',
      },
    },
    required: ['phoneNumber'],
    additionalProperties: false,
  },
  handler,
};
