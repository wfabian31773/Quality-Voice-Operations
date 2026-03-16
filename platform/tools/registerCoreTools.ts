import { globalToolRegistry } from './registry';
import { lookupCustomerTool } from './lookupCustomer';
import { updateCrmRecordTool } from './updateCrmRecord';
import { recordCallOutcomeTool } from './recordCallOutcome';
import { createCampaignContactTool } from './createCampaignContact';

export function registerCoreTools(): void {
  globalToolRegistry.register(lookupCustomerTool);
  globalToolRegistry.register(updateCrmRecordTool);
  globalToolRegistry.register(recordCallOutcomeTool);
  globalToolRegistry.register(createCampaignContactTool);
}
