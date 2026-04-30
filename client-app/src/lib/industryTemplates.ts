import {
  type AgentBuilderTKey,
  type IndustryTemplateKey,
  getIndustryTemplateCopy,
  makeBuilderT,
  tBuilder,
} from './agentBuilderI18n';

export type BuilderT = (
  key: AgentBuilderTKey,
  params?: Record<string, string | number>,
) => string;

export interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

export interface IndustryTemplateShapeNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  nodeType: string;
  conditionField?: string;
}

export interface IndustryTemplateShapeEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  /** Translation key resolved against the agent's spoken language. */
  labelKey?: AgentBuilderTKey;
}

export interface IndustryTemplateShape {
  labelKey: AgentBuilderTKey;
  descriptionKey: AgentBuilderTKey;
  key: IndustryTemplateKey;
  nodes: IndustryTemplateShapeNode[];
  edges: IndustryTemplateShapeEdge[];
}

export interface IndustryTemplate {
  label: string;
  labelKey: AgentBuilderTKey;
  description: string;
  descriptionKey: AgentBuilderTKey;
  key: IndustryTemplateKey;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** True when the active language has no translated industry copy and English fallback was used. */
  usedEnglishFallback: boolean;
}

export const NODE_TYPE_TO_LABEL_KEY: Record<string, AgentBuilderTKey> = {
  greeting: 'nodeGreeting',
  askQuestion: 'nodeAskQuestion',
  confirmInfo: 'nodeConfirmInfo',
  condition: 'nodeCondition',
  routeDecision: 'nodeRouteDecision',
  createTicket: 'nodeCreateTicket',
  createContact: 'nodeCreateContact',
  scheduleAppt: 'nodeScheduleAppt',
  sendSms: 'nodeSendSms',
  dispatchJob: 'nodeDispatchJob',
};

const NODE_LABEL_FALLBACK_EN: Record<string, string> = {
  greeting: 'Greeting',
  askQuestion: 'Ask Question',
  confirmInfo: 'Confirm Info',
  condition: 'Condition / If',
  routeDecision: 'Route Decision',
  createTicket: 'Create Ticket',
  createContact: 'Create Contact',
  scheduleAppt: 'Schedule Appointment',
  sendSms: 'Send SMS',
  dispatchJob: 'Dispatch Job',
};

export function getNodeLabel(type: string, t?: BuilderT): string {
  const key = NODE_TYPE_TO_LABEL_KEY[type];
  if (key && t) return t(key);
  return NODE_LABEL_FALLBACK_EN[type] ?? type;
}

export const INDUSTRY_TEMPLATES_RAW: IndustryTemplateShape[] = [
  {
    labelKey: 'tplMedical',
    descriptionKey: 'tplMedicalDesc',
    key: 'medical',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'condition', conditionField: 'urgency === "emergency"' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'createTicket' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelUrgent' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelRoutine' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplDental',
    descriptionKey: 'tplDentalDesc',
    key: 'dental',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'action', position: { x: 250, y: 300 }, nodeType: 'scheduleAppt' },
      { id: '4', type: 'conversation', position: { x: 250, y: 450 }, nodeType: 'confirmInfo' },
      { id: '5', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4' },
      { id: 'e4-5', source: '4', target: '5' },
    ],
  },
  {
    labelKey: 'tplHvac',
    descriptionKey: 'tplHvacDesc',
    key: 'hvac',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'condition', conditionField: 'isEmergency === true' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'dispatchJob' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelEmergency' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelRoutine' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplLegal',
    descriptionKey: 'tplLegalDesc',
    key: 'legal',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'action', position: { x: 250, y: 300 }, nodeType: 'createContact' },
      { id: '4', type: 'action', position: { x: 250, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '5', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4' },
      { id: 'e4-5', source: '4', target: '5' },
    ],
  },
  {
    labelKey: 'tplSupport',
    descriptionKey: 'tplSupportDesc',
    key: 'support',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'routeDecision', conditionField: 'issueType' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'createTicket' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'scheduleAppt' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelTicket' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelCallback' },
    ],
  },
  {
    labelKey: 'tplRealEstate',
    descriptionKey: 'tplRealEstateDesc',
    key: 'realestate',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'action', position: { x: 250, y: 300 }, nodeType: 'createContact' },
      { id: '4', type: 'action', position: { x: 250, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '5', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4' },
      { id: 'e4-5', source: '4', target: '5' },
    ],
  },
  {
    labelKey: 'tplRestaurant',
    descriptionKey: 'tplRestaurantDesc',
    key: 'restaurant',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'condition', conditionField: 'tableAvailable === true' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'createTicket' },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelAvailable' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelWaitlist' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplSalon',
    descriptionKey: 'tplSalonDesc',
    key: 'salon',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'action', position: { x: 250, y: 300 }, nodeType: 'scheduleAppt' },
      { id: '4', type: 'conversation', position: { x: 250, y: 450 }, nodeType: 'confirmInfo' },
      { id: '5', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4' },
      { id: 'e4-5', source: '4', target: '5' },
    ],
  },
  {
    labelKey: 'tplPropertyManagement',
    descriptionKey: 'tplPropertyManagementDesc',
    key: 'propertymanagement',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'condition', conditionField: 'requestType === "maintenance"' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'createTicket' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelMaintenance' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelTour' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplCustomerSupport',
    descriptionKey: 'tplCustomerSupportDesc',
    key: 'customer-support',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'condition', conditionField: 'priority === "high"' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'createTicket' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelTicket' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelCallback' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplOutboundSales',
    descriptionKey: 'tplOutboundSalesDesc',
    key: 'outbound-sales',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'condition', conditionField: 'qualified === true' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'createContact' },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelYes' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelNo' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplTechnicalSupport',
    descriptionKey: 'tplTechnicalSupportDesc',
    key: 'technical-support',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'condition', conditionField: 'severity === "tier2"' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'createTicket' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelTicket' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelCallback' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplCollections',
    descriptionKey: 'tplCollectionsDesc',
    key: 'collections',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, nodeType: 'greeting' },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, nodeType: 'askQuestion' },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, nodeType: 'condition', conditionField: 'paymentArrangement === true' },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, nodeType: 'scheduleAppt' },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, nodeType: 'createTicket' },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, nodeType: 'sendSms' },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', labelKey: 'edgeLabelYes' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', labelKey: 'edgeLabelNo' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
];

/**
 * Build the industry templates for display.
 *
 * - `uiT` is bound to the viewer's UI language and is used for labels shown
 *   in the picker (template name, description, node-library fallbacks).
 * - `language` is the agent's spoken language. Workflow data that gets
 *   persisted with the agent (node labels, edge labels) is localised against
 *   this language so the saved workflow stays internally consistent.
 */
export function buildIndustryTemplates(uiT: BuilderT, language: string): IndustryTemplate[] {
  const agentT = makeBuilderT(language);
  return INDUSTRY_TEMPLATES_RAW.map((tpl) => {
    const copy = getIndustryTemplateCopy(language, tpl.key);
    const nodes: WorkflowNode[] = tpl.nodes.map((n) => {
      const nodeCopy = copy.nodes[n.id];
      const data: Record<string, unknown> = {
        nodeType: n.nodeType,
        label: nodeCopy?.label ?? getNodeLabel(n.nodeType, agentT),
      };
      if (nodeCopy?.prompt) data.prompt = nodeCopy.prompt;
      if (nodeCopy?.toolConfig) data.toolConfig = nodeCopy.toolConfig;
      if (n.conditionField) data.conditionField = n.conditionField;
      return {
        id: n.id,
        type: n.type,
        position: n.position,
        data,
      };
    });
    const edges: WorkflowEdge[] = tpl.edges.map((e) => {
      const { labelKey, ...rest } = e;
      const edge: WorkflowEdge = { ...rest };
      if (labelKey) edge.label = agentT(labelKey);
      return edge;
    });
    return {
      label: uiT(tpl.labelKey),
      labelKey: tpl.labelKey,
      description: uiT(tpl.descriptionKey),
      descriptionKey: tpl.descriptionKey,
      key: tpl.key,
      nodes,
      edges,
      usedEnglishFallback: copy.usedEnglishFallback,
    };
  });
}

/** Helper convenience: build templates with the same language for UI and agent. */
export function buildIndustryTemplatesForLanguage(language: string): IndustryTemplate[] {
  return buildIndustryTemplates(
    (key, params) => tBuilder(language, key, params),
    language,
  );
}
