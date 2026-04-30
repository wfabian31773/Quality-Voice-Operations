import { describe, it, expect } from 'vitest';

import { tBuilder, FALLBACK_MARKER, type AgentBuilderTKey } from '../../client-app/src/lib/agentBuilderI18n';
import { AGENT_LANGUAGES } from '../../client-app/src/lib/agentLanguages';

const ALL_KEYS: AgentBuilderTKey[] = [
  'back', 'agentNamePlaceholder', 'unsaved', 'saved', 'saving', 'save', 'errorPrefix', 'saveError',
  'deployTooltipTitle', 'deployTooltipDesc', 'cannotConnect', 'rolledBack', 'published', 'publishing',
  'publishAgent', 'publishHelper', 'currentLiveVersion', 'rollbackConfirm', 'loadingAgent', 'templates',
  'voice', 'test', 'improve', 'deploy', 'startBuilding', 'startBuildingHelper', 'nodeLibrary',
  'nodeLibraryHelper', 'categoryConversation', 'categoryLogic', 'categoryAction', 'nodeGreeting',
  'nodeAskQuestion', 'nodeConfirmInfo', 'nodeCondition', 'nodeRouteDecision', 'nodeCreateTicket',
  'nodeCreateContact', 'nodeScheduleAppt', 'nodeSendSms', 'nodeDispatchJob', 'descGreeting',
  'descAskQuestion', 'descConfirmInfo', 'descCondition', 'descRouteDecision', 'descCreateTicket',
  'descCreateContact', 'descScheduleAppt', 'descSendSms', 'descDispatchJob', 'nodeConfiguration',
  'label', 'promptInstructions', 'promptPlaceholder', 'conditionExpression', 'conditionPlaceholder',
  'conditionHelper', 'tool', 'configuration', 'toolConfigPlaceholder', 'close', 'deleteNode',
  'voiceAgentConfig', 'voiceField', 'voiceRecommendedForLang', 'voiceOtherGroupLabel',
  'voiceMismatchWarning', 'voiceRecommendedHint', 'voiceSwitchToRecommended', 'voicePreviewPlay',
  'voicePreviewStop', 'voicePreviewLoading', 'voicePreviewError', 'voicePreviewRateLimited',
  'voicePreviewDefaultSample', 'voicePreviewRecommendedBadge', 'modelField', 'languageField',
  'languageHelper', 'tonePersonality', 'temperatureField', 'precise', 'creative', 'speakingRate',
  'slower', 'faster', 'welcomeGreeting', 'welcomeGreetingPlaceholder',
  'welcomeGreetingSuggestionLabel', 'welcomeGreetingSuggestionApply',
  'welcomeGreetingSuggestionApplied', 'systemPrompt', 'systemPromptPlaceholder', 'systemPromptHelper',
  'assignedWorkflow', 'none', 'workflowHelper', 'testConsole', 'reset', 'previewWorkflow',
  'previewHelper', 'liveTestHelper', 'addNodesToTest', 'simulating', 'simComplete',
  'callerResponsePlaceholder', 'sendMessage', 'endOfWorkflow', 'workflowSimComplete', 'evaluating',
  'branch', 'executing', 'completedSuccessfully', 'agentStepExecuting', 'deployment', 'phoneNumbers',
  'noNumbersAssigned', 'remove', 'assignNumberPlaceholder', 'failedAssign', 'failedUnassign',
  'versionHistory', 'noPublishedVersions', 'liveBadge', 'rollbackTitle', 'viewAnalytics',
  'improvementSuggestions', 'noPendingSuggestions', 'suggestionsHelper', 'pendingSuggestion',
  'pendingSuggestions', 'current', 'suggested', 'rationale', 'before', 'after', 'delta', 'apply',
  'applying', 'dismiss', 'tonePro', 'toneFriendly', 'toneCasual', 'toneEmpathetic', 'toneFormal',
  'toneWarm', 'toneDirect', 'tplMedical', 'tplDental', 'tplHvac', 'tplLegal', 'tplSupport',
  'tplRealEstate', 'tplRestaurant', 'tplSalon', 'tplMedicalDesc', 'tplDentalDesc', 'tplHvacDesc',
  'tplLegalDesc', 'tplSupportDesc', 'tplRealEstateDesc', 'tplRestaurantDesc', 'tplSalonDesc',
  'tplPropertyManagement', 'tplPropertyManagementDesc',
  'tplCustomerSupport', 'tplCustomerSupportDesc',
  'tplOutboundSales', 'tplOutboundSalesDesc',
  'tplTechnicalSupport', 'tplTechnicalSupportDesc',
  'tplCollections', 'tplCollectionsDesc',
  'edgeLabelMaintenance', 'edgeLabelTour',
  'agentTypeGeneral', 'agentTypeAnsweringService', 'agentTypeMedicalAfterHours',
  'agentTypeOutboundScheduling', 'agentTypeAppointmentConfirmation', 'agentTypeCustom',
  'agentTypeDental', 'agentTypePropertyManagement', 'agentTypeHomeServices', 'agentTypeLegal',
  'agentTypeCustomerSupport', 'agentTypeOutboundSales', 'agentTypeTechnicalSupport',
  'agentTypeCollections', 'agentTypeRealEstate', 'agentTypeRestaurant', 'agentTypeSalon',
  'commandBarTitle', 'commandBarPlaceholder', 'commandBarHint', 'commandBarKeyboardHint',
  'commandBarOpen', 'cmdAddNode', 'cmdConnectNodes', 'cmdFocusNode', 'cmdNoMatches',
  'keyboardShortcutsLabel', 'moreActions', 'templateFallbackHint', 'templatePreviewAria',
  'templateStepsLabel', 'templatesPickerHint', 'customTemplatesHeader', 'customTemplatesEmpty',
  'customTemplatesYoursHeader', 'customTemplatesSharedHeader', 'startBuildingCuratedHeader',
  'saveAsTemplate', 'saveTemplateTitle', 'saveTemplateNameLabel', 'saveTemplateNamePlaceholder',
  'saveTemplateDescLabel', 'saveTemplateDescPlaceholder', 'saveTemplateShareLabel',
  'saveTemplateShareHelper', 'saveTemplateConfirm', 'saveTemplateCancel', 'saveTemplateSaving',
  'saveTemplateSuccess', 'saveTemplateEmptyCanvas', 'saveTemplateError', 'deleteCustomTemplate',
  'deleteCustomTemplateConfirm', 'deleteCustomTemplateSuccess', 'sharedBadge', 'createdByYouLabel',
  'customTemplateAuthorLabel', 'customTemplateUpdatedLabel', 'customTemplateUpdatedJustNow',
  'customTemplateUpdatedMinutes', 'customTemplateUpdatedHours', 'customTemplateUpdatedDays',
  'customTemplateUnknownAuthor', 'translateGreetingPrompt', 'translateSystemPromptPrompt',
  'translateAction', 'translateRunning', 'translateDismiss', 'translateError', 'translateSuccess',
  'kbdHelpButton', 'kbdHelpTitle', 'kbdHelpClose', 'kbdHelpIntro', 'kbdGroupNavigate',
  'kbdGroupEdit', 'kbdGroupConnect', 'kbdGroupHelp', 'kbdShortcutTab', 'kbdShortcutEnter',
  'kbdShortcutEscape', 'kbdShortcutArrows', 'kbdShortcutShiftArrows', 'kbdShortcutDelete',
  'kbdShortcutConnect', 'kbdShortcutCommandPalette', 'kbdShortcutSlash', 'kbdShortcutHelp',
  'connectModeBanner', 'connectModeHelp', 'connectModeCancel', 'connectModeNoSelection',
  'connectModeSameNode', 'connectModeCancelled', 'connectModeCompleted', 'connectModeDuplicate',
  'weaknessPromptStructure', 'weaknessQuestionOrdering', 'weaknessObjectionHandling',
  'weaknessWorkflowEfficiency', 'weaknessTone', 'weaknessAccuracy', 'weaknessResolution',
];

describe('Agent Builder i18n coverage', () => {
  it('every supported agent language translates every AgentBuilderTKey without falling back to English', () => {
    const failures: string[] = [];
    for (const lang of AGENT_LANGUAGES) {
      for (const key of ALL_KEYS) {
        const value = tBuilder(lang.code, key);
        if (value.startsWith(FALLBACK_MARKER)) {
          failures.push(`${lang.code}.${key} fell back to English`);
        }
        if (!value || value.trim().length === 0) {
          failures.push(`${lang.code}.${key} is empty`);
        }
      }
    }
    if (failures.length) {
      throw new Error(`Found ${failures.length} translation gaps:\n${failures.slice(0, 20).join('\n')}`);
    }
    expect(failures.length).toBe(0);
  });
});
