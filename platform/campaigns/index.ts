export {
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  deleteCampaign,
  getCampaignMetrics,
  getTypeSpecificMetrics,
  updateContactTypeDisposition,
  addContacts,
  getContact,
  listContacts,
  getNextPendingContact,
  updateContactStatus,
  checkCampaignCompletion,
  getRunningCampaigns,
  reconcileInboundCallback,
  registerCallSid,
  resolveContactByCallSid,
  getActiveDialingCount,
  getTenantActiveDialingCount,
  getTenantMaxConcurrent,
} from './CampaignService';
export type { CallbackReconciliation } from './CampaignService';

export { dialContact } from './OutboundDialer';
export { classifyCallOutcome } from './OutcomeClassifier';
export type { CallClassificationInput } from './OutcomeClassifier';
export { CampaignScheduler, startCampaignScheduler, stopCampaignScheduler } from './CampaignScheduler';
export { addToDnc, isOnDnc, listDnc, removeFromDnc, detectOptOutInTranscript, isSmsOptOut } from './DncService';
export type { DncEntry } from './DncService';
export {
  getCampaignTypeDefinition,
  getAllCampaignTypes,
  getValidCampaignTypes,
  getDispositionsForType,
  isValidDisposition,
} from './CampaignTypeRegistry';
export type { CampaignTypeDefinition } from './CampaignTypeRegistry';
export { buildCampaignTypePromptAugmentation, classifyTypeDisposition } from './CampaignPromptService';
export type {
  Campaign, CampaignContact, CampaignMetrics, CampaignStatus,
  ContactStatus, ContactOutcome, CampaignScheduleConfig,
  CreateCampaignParams, UpdateCampaignParams,
  CampaignType, TypeSpecificMetrics, TypeDisposition,
} from './types';
