import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type OnConnect,
  Handle,
  Position,
  MarkerType,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../lib/api';
import {
  AGENT_LANGUAGES,
  DEFAULT_AGENT_LANGUAGE,
  normalizeAgentLanguage,
  getRecommendedVoicesForLanguage,
  isVoiceRecommendedForLanguage,
  getAgentLanguageLabel,
} from '../lib/agentLanguages';
import {
  type AgentBuilderTKey,
  makeBuilderT,
  getDefaultWelcomeGreeting,
  getDefaultSystemPrompt,
  isDefaultGreeting,
  isDefaultSystemPrompt,
} from '../lib/agentBuilderI18n';
import {
  ArrowLeft, Save, Play, Rocket, History, GripVertical,
  MessageSquare, HelpCircle, CheckCircle, GitBranch, Route,
  Ticket, UserPlus, Calendar, Send, Truck, Phone,
  X, ChevronDown, ChevronRight, Mic, Settings2, Zap,
  RotateCcw, Eye, Trash2, Lightbulb, Check, XCircle, TrendingUp,
  AlertTriangle, Keyboard, Search,
} from 'lucide-react';
import TooltipWalkthrough from '../components/TooltipWalkthrough';

type BuilderT = (key: AgentBuilderTKey, params?: Record<string, string | number>) => string;

interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
  voice: string;
  model: string;
  language: string;
  system_prompt: string;
  welcome_greeting: string;
  temperature: number;
  workflow_definition: WorkflowDefinition | null;
  published_workflow_definition: WorkflowDefinition | null;
  published_version: number | null;
  tools: Record<string, unknown>[];
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string;
  routed_agent_id: string | null;
  routing_active: boolean;
  status: string;
}

interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

interface VersionInfo {
  id: string;
  version: number;
  status: string;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
}

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'];
const MODELS = ['gpt-4o-realtime-preview', 'gpt-4o-mini-realtime-preview'];

interface NodeCategory {
  label: string;
  categoryKey: AgentBuilderTKey;
  icon: React.ReactNode;
  nodes: {
    type: string;
    labelKey: AgentBuilderTKey;
    descKey: AgentBuilderTKey;
    icon: React.ReactNode;
  }[];
}

const NODE_TYPE_TO_LABEL_KEY: Record<string, AgentBuilderTKey> = {
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

const NODE_TYPE_TO_ICON: Record<string, React.ReactNode> = {
  greeting: <Phone className="h-4 w-4" />,
  askQuestion: <HelpCircle className="h-4 w-4" />,
  confirmInfo: <CheckCircle className="h-4 w-4" />,
  condition: <GitBranch className="h-4 w-4" />,
  routeDecision: <Route className="h-4 w-4" />,
  createTicket: <Ticket className="h-4 w-4" />,
  createContact: <UserPlus className="h-4 w-4" />,
  scheduleAppt: <Calendar className="h-4 w-4" />,
  sendSms: <Send className="h-4 w-4" />,
  dispatchJob: <Truck className="h-4 w-4" />,
};

function buildNodeLibrary(t: BuilderT): NodeCategory[] {
  return [
    {
      label: t('categoryConversation'),
      categoryKey: 'categoryConversation',
      icon: <MessageSquare className="h-4 w-4" />,
      nodes: [
        { type: 'greeting', labelKey: 'nodeGreeting', descKey: 'descGreeting', icon: NODE_TYPE_TO_ICON.greeting },
        { type: 'askQuestion', labelKey: 'nodeAskQuestion', descKey: 'descAskQuestion', icon: NODE_TYPE_TO_ICON.askQuestion },
        { type: 'confirmInfo', labelKey: 'nodeConfirmInfo', descKey: 'descConfirmInfo', icon: NODE_TYPE_TO_ICON.confirmInfo },
      ],
    },
    {
      label: t('categoryLogic'),
      categoryKey: 'categoryLogic',
      icon: <GitBranch className="h-4 w-4" />,
      nodes: [
        { type: 'condition', labelKey: 'nodeCondition', descKey: 'descCondition', icon: NODE_TYPE_TO_ICON.condition },
        { type: 'routeDecision', labelKey: 'nodeRouteDecision', descKey: 'descRouteDecision', icon: NODE_TYPE_TO_ICON.routeDecision },
      ],
    },
    {
      label: t('categoryAction'),
      categoryKey: 'categoryAction',
      icon: <Zap className="h-4 w-4" />,
      nodes: [
        { type: 'createTicket', labelKey: 'nodeCreateTicket', descKey: 'descCreateTicket', icon: NODE_TYPE_TO_ICON.createTicket },
        { type: 'createContact', labelKey: 'nodeCreateContact', descKey: 'descCreateContact', icon: NODE_TYPE_TO_ICON.createContact },
        { type: 'scheduleAppt', labelKey: 'nodeScheduleAppt', descKey: 'descScheduleAppt', icon: NODE_TYPE_TO_ICON.scheduleAppt },
        { type: 'sendSms', labelKey: 'nodeSendSms', descKey: 'descSendSms', icon: NODE_TYPE_TO_ICON.sendSms },
        { type: 'dispatchJob', labelKey: 'nodeDispatchJob', descKey: 'descDispatchJob', icon: NODE_TYPE_TO_ICON.dispatchJob },
      ],
    },
  ];
}

const NODE_COLORS: Record<string, { bg: string; border: string; text: string; handle: string }> = {
  greeting: { bg: 'bg-emerald-50 dark:bg-emerald-900/30', border: 'border-emerald-300 dark:border-emerald-700', text: 'text-emerald-700 dark:text-emerald-300', handle: '#10b981' },
  askQuestion: { bg: 'bg-blue-50 dark:bg-blue-900/30', border: 'border-blue-300 dark:border-blue-700', text: 'text-blue-700 dark:text-blue-300', handle: '#3b82f6' },
  confirmInfo: { bg: 'bg-indigo-50 dark:bg-indigo-900/30', border: 'border-indigo-300 dark:border-indigo-700', text: 'text-indigo-700 dark:text-indigo-300', handle: '#6366f1' },
  condition: { bg: 'bg-amber-50 dark:bg-amber-900/30', border: 'border-amber-300 dark:border-amber-700', text: 'text-amber-700 dark:text-amber-300', handle: '#f59e0b' },
  routeDecision: { bg: 'bg-orange-50 dark:bg-orange-900/30', border: 'border-orange-300 dark:border-orange-700', text: 'text-orange-700 dark:text-orange-300', handle: '#f97316' },
  createTicket: { bg: 'bg-purple-50 dark:bg-purple-900/30', border: 'border-purple-300 dark:border-purple-700', text: 'text-purple-700 dark:text-purple-300', handle: '#a855f7' },
  createContact: { bg: 'bg-pink-50 dark:bg-pink-900/30', border: 'border-pink-300 dark:border-pink-700', text: 'text-pink-700 dark:text-pink-300', handle: '#ec4899' },
  scheduleAppt: { bg: 'bg-cyan-50 dark:bg-cyan-900/30', border: 'border-cyan-300 dark:border-cyan-700', text: 'text-cyan-700 dark:text-cyan-300', handle: '#06b6d4' },
  sendSms: { bg: 'bg-teal-50 dark:bg-teal-900/30', border: 'border-teal-300 dark:border-teal-700', text: 'text-teal-700 dark:text-teal-300', handle: '#14b8a6' },
  dispatchJob: { bg: 'bg-rose-50 dark:bg-rose-900/30', border: 'border-rose-300 dark:border-rose-700', text: 'text-rose-700 dark:text-rose-300', handle: '#f43f5e' },
};

const DEFAULT_COLORS = { bg: 'bg-surface-hover', border: 'border-border', text: 'text-text-primary', handle: '#6b7280' };

function getNodeIcon(type: string) {
  return NODE_TYPE_TO_ICON[type] ?? <MessageSquare className="h-4 w-4" />;
}

function getNodeLabel(type: string, t?: BuilderT) {
  const key = NODE_TYPE_TO_LABEL_KEY[type];
  if (key && t) return t(key);
  // Fallback English labels (used when no translator is available, e.g. logging contexts).
  const fallbackEn: Record<string, string> = {
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
  return fallbackEn[type] ?? type;
}

function ConversationNode({ data, selected }: { data: Record<string, unknown>; selected: boolean }) {
  const nodeType = (data.nodeType as string) || 'greeting';
  const colors = NODE_COLORS[nodeType] || DEFAULT_COLORS;
  const label = (data.label as string) || getNodeLabel(nodeType);
  const prompt = (data.prompt as string) || '';

  return (
    <div className={`rounded-xl border-2 ${colors.border} ${colors.bg} shadow-sm min-w-[200px] max-w-[260px] transition-shadow ${selected ? 'shadow-lg ring-4 ring-primary ring-offset-2 ring-offset-surface-secondary' : ''}`}>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !border-2 !border-white" style={{ background: colors.handle }} />
      <div className="px-3 py-2 border-b border-inherit">
        <div className={`flex items-center gap-2 ${colors.text} font-medium text-sm`}>
          {getNodeIcon(nodeType)}
          <span>{label}</span>
        </div>
      </div>
      {prompt && (
        <div className="px-3 py-2">
          <p className="text-xs text-text-secondary line-clamp-2">{prompt}</p>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !border-2 !border-white" style={{ background: colors.handle }} />
    </div>
  );
}

function LogicNode({ data, selected }: { data: Record<string, unknown>; selected: boolean }) {
  const nodeType = (data.nodeType as string) || 'condition';
  const colors = NODE_COLORS[nodeType] || DEFAULT_COLORS;
  const label = (data.label as string) || getNodeLabel(nodeType);
  const conditionField = (data.conditionField as string) || '';

  return (
    <div className={`rounded-xl border-2 ${colors.border} ${colors.bg} shadow-sm min-w-[200px] max-w-[260px] transition-shadow ${selected ? 'shadow-lg ring-4 ring-primary ring-offset-2 ring-offset-surface-secondary' : ''}`}
      style={{ transform: 'rotate(0deg)' }}>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !border-2 !border-white" style={{ background: colors.handle }} />
      <div className="px-3 py-2 border-b border-inherit">
        <div className={`flex items-center gap-2 ${colors.text} font-medium text-sm`}>
          {getNodeIcon(nodeType)}
          <span>{label}</span>
        </div>
      </div>
      {conditionField && (
        <div className="px-3 py-2">
          <p className="text-xs text-text-secondary">If: {conditionField}</p>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="yes" className="!w-3 !h-3 !border-2 !border-white" style={{ background: colors.handle, left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="no" className="!w-3 !h-3 !border-2 !border-white" style={{ background: '#ef4444', left: '70%' }} />
    </div>
  );
}

function ActionNode({ data, selected }: { data: Record<string, unknown>; selected: boolean }) {
  const nodeType = (data.nodeType as string) || 'createTicket';
  const colors = NODE_COLORS[nodeType] || DEFAULT_COLORS;
  const label = (data.label as string) || getNodeLabel(nodeType);
  const toolConfig = (data.toolConfig as string) || '';

  return (
    <div className={`rounded-xl border-2 ${colors.border} ${colors.bg} shadow-sm min-w-[200px] max-w-[260px] transition-shadow ${selected ? 'shadow-lg ring-4 ring-primary ring-offset-2 ring-offset-surface-secondary' : ''}`}>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !border-2 !border-white" style={{ background: colors.handle }} />
      <div className="px-3 py-2 border-b border-inherit">
        <div className={`flex items-center gap-2 ${colors.text} font-medium text-sm`}>
          {getNodeIcon(nodeType)}
          <span>{label}</span>
        </div>
      </div>
      {toolConfig && (
        <div className="px-3 py-2">
          <p className="text-xs text-text-secondary line-clamp-2">{toolConfig}</p>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !border-2 !border-white" style={{ background: colors.handle }} />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  conversation: ConversationNode,
  logic: LogicNode,
  action: ActionNode,
};

function getNodeCategory(type: string): string {
  const logicTypes = ['condition', 'routeDecision'];
  const actionTypes = ['createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob'];
  if (logicTypes.includes(type)) return 'logic';
  if (actionTypes.includes(type)) return 'action';
  return 'conversation';
}

const EDGE_RULES: Record<string, string[]> = {
  greeting: ['askQuestion', 'confirmInfo', 'condition', 'routeDecision', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob'],
  askQuestion: ['askQuestion', 'confirmInfo', 'condition', 'routeDecision', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob'],
  confirmInfo: ['condition', 'routeDecision', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob', 'askQuestion'],
  condition: ['askQuestion', 'confirmInfo', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob', 'condition', 'routeDecision'],
  routeDecision: ['askQuestion', 'confirmInfo', 'createTicket', 'createContact', 'scheduleAppt', 'sendSms', 'dispatchJob', 'condition'],
  createTicket: ['sendSms', 'scheduleAppt', 'confirmInfo', 'askQuestion'],
  createContact: ['sendSms', 'scheduleAppt', 'confirmInfo', 'createTicket', 'askQuestion'],
  scheduleAppt: ['sendSms', 'confirmInfo', 'createTicket', 'askQuestion'],
  sendSms: ['confirmInfo', 'askQuestion'],
  dispatchJob: ['sendSms', 'confirmInfo', 'askQuestion'],
};

function isValidConnection(sourceNodeType: string, targetNodeType: string): boolean {
  const allowed = EDGE_RULES[sourceNodeType];
  if (!allowed) return true;
  return allowed.includes(targetNodeType);
}

interface IndustryTemplate {
  label: string;
  labelKey: AgentBuilderTKey;
  key: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

const INDUSTRY_TEMPLATES_RAW: { labelKey: AgentBuilderTKey; key: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] }[] = [
  {
    labelKey: 'tplMedical',
    key: 'medical',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, data: { nodeType: 'greeting', label: 'Patient Greeting', prompt: 'Warmly greet the patient. Identify yourself as the after-hours service.' } },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, data: { nodeType: 'askQuestion', label: 'Symptom Assessment', prompt: 'Ask about symptoms, severity, and duration.' } },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, data: { nodeType: 'condition', label: 'Urgency Check', conditionField: 'urgency === "emergency"' } },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, data: { nodeType: 'createTicket', label: 'Urgent Ticket', toolConfig: 'Priority: HIGH, Notify on-call provider immediately' } },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, data: { nodeType: 'scheduleAppt', label: 'Schedule Follow-up', toolConfig: 'Next available appointment slot' } },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, data: { nodeType: 'sendSms', label: 'SMS Confirmation', toolConfig: 'Send appointment/ticket confirmation' } },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', label: 'Urgent' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', label: 'Routine' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplDental',
    key: 'dental',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, data: { nodeType: 'greeting', label: 'Welcome', prompt: 'Welcome the patient to the dental office.' } },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, data: { nodeType: 'askQuestion', label: 'Reason for Visit', prompt: 'Ask if they need a cleaning, checkup, or have a dental issue.' } },
      { id: '3', type: 'action', position: { x: 250, y: 300 }, data: { nodeType: 'scheduleAppt', label: 'Book Dental Appt', toolConfig: 'Check dentist availability' } },
      { id: '4', type: 'conversation', position: { x: 250, y: 450 }, data: { nodeType: 'confirmInfo', label: 'Confirm Details', prompt: 'Confirm the appointment date, time, and patient info.' } },
      { id: '5', type: 'action', position: { x: 250, y: 600 }, data: { nodeType: 'sendSms', label: 'Send Reminder', toolConfig: 'SMS with appointment details' } },
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
    key: 'hvac',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, data: { nodeType: 'greeting', label: 'Service Call', prompt: 'Answer the service call professionally.' } },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, data: { nodeType: 'askQuestion', label: 'Issue Details', prompt: 'Collect details about the HVAC/home service issue.' } },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, data: { nodeType: 'condition', label: 'Emergency?', conditionField: 'isEmergency === true' } },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, data: { nodeType: 'dispatchJob', label: 'Emergency Dispatch', toolConfig: 'Priority dispatch to nearest technician' } },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, data: { nodeType: 'scheduleAppt', label: 'Schedule Service', toolConfig: 'Book regular service appointment' } },
      { id: '6', type: 'action', position: { x: 250, y: 600 }, data: { nodeType: 'sendSms', label: 'SMS Confirmation', toolConfig: 'Send service details and ETA' } },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', label: 'Emergency' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', label: 'Routine' },
      { id: 'e4-6', source: '4', target: '6' },
      { id: 'e5-6', source: '5', target: '6' },
    ],
  },
  {
    labelKey: 'tplLegal',
    key: 'legal',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, data: { nodeType: 'greeting', label: 'Caller Greeting', prompt: 'Professional legal intake greeting.' } },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, data: { nodeType: 'askQuestion', label: 'Case Details', prompt: 'Gather case type, key dates, and involved parties.' } },
      { id: '3', type: 'action', position: { x: 250, y: 300 }, data: { nodeType: 'createContact', label: 'Create Client Record', toolConfig: 'Add to CRM with case info' } },
      { id: '4', type: 'action', position: { x: 250, y: 450 }, data: { nodeType: 'scheduleAppt', label: 'Schedule Consultation', toolConfig: 'Book attorney consultation' } },
      { id: '5', type: 'action', position: { x: 250, y: 600 }, data: { nodeType: 'sendSms', label: 'Confirmation', toolConfig: 'Email with consultation details' } },
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
    key: 'support',
    nodes: [
      { id: '1', type: 'conversation', position: { x: 250, y: 0 }, data: { nodeType: 'greeting', label: 'Customer Welcome', prompt: 'Greet the customer and identify their account.' } },
      { id: '2', type: 'conversation', position: { x: 250, y: 150 }, data: { nodeType: 'askQuestion', label: 'Issue Description', prompt: 'What issue are you experiencing today?' } },
      { id: '3', type: 'logic', position: { x: 250, y: 300 }, data: { nodeType: 'routeDecision', label: 'Route by Type', conditionField: 'issueType' } },
      { id: '4', type: 'action', position: { x: 100, y: 450 }, data: { nodeType: 'createTicket', label: 'Support Ticket', toolConfig: 'Create support ticket with issue details' } },
      { id: '5', type: 'action', position: { x: 400, y: 450 }, data: { nodeType: 'scheduleAppt', label: 'Callback Schedule', toolConfig: 'Schedule callback with specialist' } },
    ],
    edges: [
      { id: 'e1-2', source: '1', target: '2' },
      { id: 'e2-3', source: '2', target: '3' },
      { id: 'e3-4', source: '3', target: '4', sourceHandle: 'yes', label: 'Ticket' },
      { id: 'e3-5', source: '3', target: '5', sourceHandle: 'no', label: 'Callback' },
    ],
  },
];

function buildIndustryTemplates(t: BuilderT): IndustryTemplate[] {
  return INDUSTRY_TEMPLATES_RAW.map((tpl) => ({
    label: t(tpl.labelKey),
    labelKey: tpl.labelKey,
    key: tpl.key,
    nodes: tpl.nodes,
    edges: tpl.edges,
  }));
}

function NodeLibrarySidebar({ onDragStart, t }: { onDragStart: (type: string, nodeType: string) => void; t: BuilderT }) {
  const library = buildNodeLibrary(t);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    categoryConversation: true,
    categoryLogic: true,
    categoryAction: true,
  });

  return (
    <div className="w-60 border-r border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">{t('nodeLibrary')}</h3>
        <p className="text-xs text-text-secondary mt-0.5">{t('nodeLibraryHelper')}</p>
      </div>
      {library.map((cat) => (
        <div key={cat.categoryKey}>
          <button
            onClick={() => setExpanded((e) => ({ ...e, [cat.categoryKey]: !e[cat.categoryKey] }))}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wider hover:bg-surface-hover transition"
          >
            {expanded[cat.categoryKey] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {cat.icon}
            {cat.label}
          </button>
          {expanded[cat.categoryKey] && (
            <div className="px-2 pb-2 space-y-1">
              {cat.nodes.map((node) => (
                <div
                  key={node.type}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/reactflow-type', getNodeCategory(node.type));
                    e.dataTransfer.setData('application/reactflow-nodetype', node.type);
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(getNodeCategory(node.type), node.type);
                  }}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:border-primary/50 hover:shadow-sm cursor-grab active:cursor-grabbing transition text-sm"
                >
                  <GripVertical className="h-3 w-3 text-text-muted flex-shrink-0" />
                  <span className={NODE_COLORS[node.type]?.text || 'text-text-primary'}>{node.icon}</span>
                  <div className="min-w-0">
                    <p className="text-text-primary font-medium text-xs">{t(node.labelKey)}</p>
                    <p className="text-text-muted text-[10px] truncate">{t(node.descKey)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function NodeConfigPanel({
  node,
  onUpdate,
  onDelete,
  onClose,
  t,
}: {
  node: Node;
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  t: BuilderT;
}) {
  const nodeType = (node.data.nodeType as string) || '';
  const category = getNodeCategory(nodeType);

  return (
    <div className="w-80 border-l border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">{t('nodeConfiguration')}</h3>
        <button onClick={onClose} aria-label={t('close')} className="text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-3 space-y-4">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('label')}</label>
          <input
            value={(node.data.label as string) || ''}
            onChange={(e) => onUpdate(node.id, { ...node.data, label: e.target.value })}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {category === 'conversation' && (
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">{t('promptInstructions')}</label>
            <textarea
              value={(node.data.prompt as string) || ''}
              onChange={(e) => onUpdate(node.id, { ...node.data, prompt: e.target.value })}
              rows={6}
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
              placeholder={t('promptPlaceholder')}
            />
          </div>
        )}

        {category === 'logic' && (
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">{t('conditionExpression')}</label>
            <input
              value={(node.data.conditionField as string) || ''}
              onChange={(e) => onUpdate(node.id, { ...node.data, conditionField: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder={t('conditionPlaceholder')}
            />
            <p className="text-[10px] text-text-muted mt-1">
              {t('conditionHelper')}
            </p>
          </div>
        )}

        {category === 'action' && (
          <>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{t('tool')}</label>
              <div className="px-3 py-1.5 rounded-lg border border-border bg-surface-hover text-text-primary text-sm">
                {getNodeLabel(nodeType, t)}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">{t('configuration')}</label>
              <textarea
                value={(node.data.toolConfig as string) || ''}
                onChange={(e) => onUpdate(node.id, { ...node.data, toolConfig: e.target.value })}
                rows={4}
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
                placeholder={t('toolConfigPlaceholder')}
              />
            </div>
          </>
        )}

        <div className="pt-2 border-t border-border">
          <button
            onClick={() => onDelete(node.id)}
            className="flex items-center gap-1.5 text-xs font-medium text-danger hover:text-red-700 transition"
          >
            <Trash2 className="h-3.5 w-3.5" /> {t('deleteNode')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ImprovementSuggestion {
  id: string;
  agentId: string;
  status: 'pending' | 'accepted' | 'dismissed';
  weaknessCategory: string;
  weaknessDescription: string;
  currentPromptSection: string;
  suggestedPromptSection: string;
  rationale: string;
  simulationScoreBefore: number | null;
  simulationScoreAfter: number | null;
  createdAt: string;
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    prompt_structure: 'Prompt Structure',
    question_ordering: 'Question Ordering',
    objection_handling: 'Objection Handling',
    workflow_efficiency: 'Workflow Efficiency',
    tone: 'Tone',
    accuracy: 'Accuracy',
    resolution: 'Resolution',
  };
  return labels[cat] || cat;
}

function categoryColor(cat: string): string {
  const colors: Record<string, string> = {
    prompt_structure: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    question_ordering: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    objection_handling: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    workflow_efficiency: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
    tone: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
    accuracy: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    resolution: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  };
  return colors[cat] || 'bg-surface-hover text-text-primary';
}

function ImprovementSuggestionsPanel({
  agentId,
  onClose,
  t,
}: {
  agentId: string;
  onClose: () => void;
  t: BuilderT;
}) {
  const [suggestions, setSuggestions] = useState<ImprovementSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    api
      .get<{ suggestions: ImprovementSuggestion[] }>(`/improvements/suggestions?agentId=${agentId}&status=pending`)
      .then((data) => setSuggestions(data.suggestions || []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleAccept = async (id: string) => {
    setActionLoading(id);
    try {
      await api.post(`/improvements/suggestions/${id}/accept`, {});
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
      queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const handleDismiss = async (id: string) => {
    setActionLoading(id);
    try {
      await api.post(`/improvements/suggestions/${id}/dismiss`, {});
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  return (
    <div className="w-96 border-l border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-amber-500" /> {t('improvementSuggestions')}
        </h3>
        <button onClick={onClose} aria-label={t('close')} className="text-text-secondary hover:text-text-primary">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-3">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : suggestions.length === 0 ? (
          <div className="text-center py-8">
            <Lightbulb className="h-8 w-8 text-text-muted mx-auto mb-2" />
            <p className="text-sm text-text-secondary">{t('noPendingSuggestions')}</p>
            <p className="text-xs text-text-muted mt-1">
              {t('suggestionsHelper')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-text-secondary">
              {suggestions.length === 1
                ? t('pendingSuggestion', { count: suggestions.length })
                : t('pendingSuggestions', { count: suggestions.length })}
            </p>
            {suggestions.map((s) => (
              <div key={s.id} className="border border-border rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                  className="w-full text-left px-3 py-2.5 hover:bg-surface-hover/50 transition"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mb-1 ${categoryColor(s.weaknessCategory)}`}>
                        {categoryLabel(s.weaknessCategory)}
                      </span>
                      <p className="text-xs text-text-primary line-clamp-2">{s.weaknessDescription}</p>
                    </div>
                    {s.simulationScoreBefore != null && s.simulationScoreAfter != null && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-[10px] text-red-500">{s.simulationScoreBefore.toFixed(1)}</span>
                        <TrendingUp className="h-3 w-3 text-green-500" />
                        <span className="text-[10px] text-green-500">{s.simulationScoreAfter.toFixed(1)}</span>
                      </div>
                    )}
                  </div>
                </button>

                {expandedId === s.id && (
                  <div className="px-3 pb-3 border-t border-border">
                    <div className="mt-2 space-y-2">
                      <div>
                        <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">{t('current')}</p>
                        <pre className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 rounded p-2 whitespace-pre-wrap max-h-24 overflow-auto">
                          {s.currentPromptSection}
                        </pre>
                      </div>
                      <div>
                        <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">{t('suggested')}</p>
                        <pre className="text-[11px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/10 rounded p-2 whitespace-pre-wrap max-h-24 overflow-auto">
                          {s.suggestedPromptSection}
                        </pre>
                      </div>
                      <div>
                        <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">{t('rationale')}</p>
                        <p className="text-xs text-text-secondary">{s.rationale}</p>
                      </div>

                      {s.simulationScoreBefore != null && s.simulationScoreAfter != null && (
                        <div className="flex items-center gap-3 bg-surface-secondary rounded-lg p-2">
                          <div className="text-center">
                            <p className="text-[10px] text-text-muted">{t('before')}</p>
                            <p className="text-sm font-bold text-red-500">{s.simulationScoreBefore.toFixed(1)}</p>
                          </div>
                          <TrendingUp className="h-4 w-4 text-green-500" />
                          <div className="text-center">
                            <p className="text-[10px] text-text-muted">{t('after')}</p>
                            <p className="text-sm font-bold text-green-500">{s.simulationScoreAfter.toFixed(1)}</p>
                          </div>
                          <div className="ml-auto text-center">
                            <p className="text-[10px] text-text-muted">{t('delta')}</p>
                            <p className="text-sm font-bold text-green-500">
                              +{(s.simulationScoreAfter - s.simulationScoreBefore).toFixed(1)}
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => handleAccept(s.id)}
                          disabled={actionLoading === s.id}
                          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 transition disabled:opacity-50"
                        >
                          <Check className="h-3 w-3" />
                          {actionLoading === s.id ? t('applying') : t('apply')}
                        </button>
                        <button
                          onClick={() => handleDismiss(s.id)}
                          disabled={actionLoading === s.id}
                          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border text-text-secondary rounded-lg hover:bg-surface-hover transition disabled:opacity-50"
                        >
                          <XCircle className="h-3 w-3" />
                          {t('dismiss')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const TONE_OPTIONS: { value: string; labelKey: AgentBuilderTKey }[] = [
  { value: 'Professional', labelKey: 'tonePro' },
  { value: 'Friendly', labelKey: 'toneFriendly' },
  { value: 'Casual', labelKey: 'toneCasual' },
  { value: 'Empathetic', labelKey: 'toneEmpathetic' },
  { value: 'Formal', labelKey: 'toneFormal' },
  { value: 'Warm', labelKey: 'toneWarm' },
  { value: 'Direct', labelKey: 'toneDirect' },
];

function VoiceConfigPanel({
  voice,
  model,
  temperature,
  systemPrompt,
  welcomeGreeting,
  language,
  tone,
  speakingRate,
  workflowId,
  workflows,
  onChange,
  onClose,
  t,
}: {
  voice: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  welcomeGreeting: string;
  language: string;
  tone: string;
  speakingRate: number;
  workflowId: string;
  workflows: { id: string; name: string; description: string | null }[];
  onChange: (key: string, value: string | number) => void;
  onClose: () => void;
  t: BuilderT;
}) {
  return (
    <div className="w-80 border-l border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <Mic className="h-4 w-4" /> {t('voiceAgentConfig')}
        </h3>
        <button onClick={onClose} aria-label={t('close')} className="text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-3 space-y-4">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('voiceField')}</label>
          {(() => {
            const recommended = getRecommendedVoicesForLanguage(language);
            const recommendedSet = new Set(recommended);
            const others = VOICES.filter((v) => !recommendedSet.has(v));
            const langLabel = getAgentLanguageLabel(language);
            const isRecommended = isVoiceRecommendedForLanguage(voice, language);
            return (
              <>
                <select
                  value={voice}
                  onChange={(e) => onChange('voice', e.target.value)}
                  className={`w-full px-3 py-1.5 rounded-lg border bg-surface text-text-primary text-sm ${
                    !isRecommended ? 'border-amber-400 dark:border-amber-600' : 'border-border'
                  }`}
                >
                  <optgroup label={t('voiceRecommendedForLang', { language: langLabel })}>
                    {recommended.map((v) => (
                      <option key={v} value={v}>★ {v}</option>
                    ))}
                  </optgroup>
                  {others.length > 0 && (
                    <optgroup label={t('voiceOtherGroupLabel')}>
                      {others.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {!isRecommended ? (
                  <div className="mt-1.5 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-2 py-1.5 space-y-1.5">
                    <div className="flex items-start gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
                        {t('voiceMismatchWarning', {
                          voice,
                          language: langLabel,
                          recommended: recommended.slice(0, 3).join(', '),
                        })}
                      </p>
                    </div>
                    {recommended[0] && recommended[0] !== voice && (
                      <button
                        type="button"
                        onClick={() => onChange('voice', recommended[0])}
                        className="w-full text-[11px] font-medium text-white bg-amber-600 hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600 rounded px-2 py-1 transition"
                      >
                        {t('voiceSwitchToRecommended', { voice: recommended[0] })}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] text-text-muted mt-1">
                    {t('voiceRecommendedHint', { language: langLabel })}
                  </p>
                )}
              </>
            );
          })()}
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('modelField')}</label>
          <select
            value={model}
            onChange={(e) => onChange('model', e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm"
          >
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('languageField')}</label>
          <select
            value={language}
            onChange={(e) => onChange('language', e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm"
          >
            {AGENT_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
                {l.nativeLabel !== l.label ? ` (${l.nativeLabel})` : ''}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-text-muted mt-1">
            {t('languageHelper')}
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('tonePersonality')}</label>
          <select
            value={tone}
            onChange={(e) => onChange('tone', e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm"
          >
            {TONE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('temperatureField')}: {temperature}</label>
          <input
            type="range" min="0" max="1" step="0.1" value={temperature}
            onChange={(e) => onChange('temperature', parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-text-muted mt-0.5">
            <span>{t('precise')}</span>
            <span>{t('creative')}</span>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('speakingRate')}: {speakingRate}x</label>
          <input
            type="range" min="0.5" max="2.0" step="0.1" value={speakingRate}
            onChange={(e) => onChange('speakingRate', parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-text-muted mt-0.5">
            <span>{t('slower')}</span>
            <span>{t('faster')}</span>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('welcomeGreeting')}</label>
          <textarea
            value={welcomeGreeting}
            onChange={(e) => onChange('welcome_greeting', e.target.value)}
            rows={3}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
            placeholder={t('welcomeGreetingPlaceholder')}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('systemPrompt')}</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => onChange('system_prompt', e.target.value)}
            rows={10}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
            placeholder={t('systemPromptPlaceholder')}
          />
          <p className="text-[10px] text-text-muted mt-1">
            {t('systemPromptHelper')}
          </p>
        </div>
        <div className="pt-2 border-t border-border">
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('assignedWorkflow')}</label>
          <select
            value={workflowId}
            onChange={(e) => onChange('workflow_id', e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm"
          >
            <option value="">{t('none')}</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          <p className="text-[10px] text-text-muted mt-1">
            {t('workflowHelper')}
          </p>
        </div>
      </div>
    </div>
  );
}

function TestConsolePanel({
  agentName,
  welcomeGreeting,
  language,
  nodes,
  edges,
  onClose,
  t,
}: {
  agentName: string;
  welcomeGreeting: string;
  language: string;
  nodes: Node[];
  edges: Edge[];
  onClose: () => void;
  t: BuilderT;
}) {
  const [messages, setMessages] = useState<{ role: string; text: string; nodeId?: string }[]>([]);
  const [input, setInput] = useState('');
  const [isSimulating, setIsSimulating] = useState(false);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [simStatus, setSimStatus] = useState<'idle' | 'running' | 'complete'>('idle');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const findStartNode = useCallback(() => {
    const targetIds = new Set(edges.map((e) => e.target));
    const startNodes = nodes.filter((n) => !targetIds.has(n.id));
    return startNodes.length > 0 ? startNodes[0] : nodes[0] || null;
  }, [nodes, edges]);

  const getNextNodes = useCallback((nodeId: string, handleId?: string) => {
    return edges
      .filter((e) => e.source === nodeId && (!handleId || e.sourceHandle === handleId))
      .map((e) => ({ node: nodes.find((n) => n.id === e.target), label: e.label }))
      .filter((item) => item.node != null);
  }, [nodes, edges]);

  const simulateNode = useCallback((node: Node) => {
    const nodeType = (node.data.nodeType as string) || '';
    const label = (node.data.label as string) || getNodeLabel(nodeType, t);
    const category = getNodeCategory(nodeType);

    setCurrentNodeId(node.id);

    if (category === 'conversation') {
      const prompt = (node.data.prompt as string) || '';
      const agentText = prompt || t('agentStepExecuting', { label });
      setMessages((prev) => [...prev, { role: 'agent', text: agentText, nodeId: node.id }]);
    } else if (category === 'logic') {
      const field = (node.data.conditionField as string) || 'condition';
      setMessages((prev) => [...prev, { role: 'system', text: t('evaluating', { field }), nodeId: node.id }]);
      setTimeout(() => {
        const yesPath = getNextNodes(node.id, 'yes');
        if (yesPath.length > 0 && yesPath[0].node) {
          setMessages((prev) => [...prev, { role: 'system', text: t('branch', { label: String(yesPath[0].label || 'Yes') }) }]);
          simulateNode(yesPath[0].node);
        }
      }, 800);
    } else if (category === 'action') {
      const config = (node.data.toolConfig as string) || '';
      const execText = config ? `${t('executing', { label })} — ${config}` : t('executing', { label });
      setMessages((prev) => [...prev, { role: 'system', text: execText, nodeId: node.id }]);
      setTimeout(() => {
        setMessages((prev) => [...prev, { role: 'system', text: t('completedSuccessfully', { label }) }]);
        const next = getNextNodes(node.id);
        if (next.length > 0 && next[0].node) {
          simulateNode(next[0].node);
        } else {
          setSimStatus('complete');
          setMessages((prev) => [...prev, { role: 'system', text: t('workflowSimComplete') }]);
        }
      }, 1000);
    }
  }, [getNextNodes, t]);

  const startSimulation = useCallback(() => {
    setIsSimulating(true);
    setSimStatus('running');
    setMessages([]);

    const greeting = welcomeGreeting || getDefaultWelcomeGreeting(language);
    setMessages([{ role: 'agent', text: greeting }]);

    const startNode = findStartNode();
    if (startNode) {
      setTimeout(() => simulateNode(startNode), 500);
    }
  }, [agentName, welcomeGreeting, language, findStartNode, simulateNode]);

  const sendMessage = () => {
    if (!input.trim()) return;
    const userText = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text: userText }]);

    if (currentNodeId) {
      const next = getNextNodes(currentNodeId);
      if (next.length > 0 && next[0].node) {
        setTimeout(() => simulateNode(next[0].node!), 600);
      } else {
        setSimStatus('complete');
        setMessages((prev) => [...prev, { role: 'system', text: t('endOfWorkflow') }]);
      }
    }
  };

  const resetSimulation = () => {
    setMessages([]);
    setIsSimulating(false);
    setCurrentNodeId(null);
    setSimStatus('idle');
  };

  return (
    <div className="w-80 border-l border-border bg-surface flex flex-col flex-shrink-0">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <Play className="h-4 w-4" /> {t('testConsole')}
        </h3>
        <div className="flex items-center gap-1">
          {isSimulating && (
            <button onClick={resetSimulation} className="text-text-secondary hover:text-primary text-xs px-1.5 py-0.5 rounded hover:bg-surface-hover transition">
              {t('reset')}
            </button>
          )}
          <button onClick={onClose} aria-label={t('close')} className="text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {nodes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-text-muted text-center">{t('addNodesToTest')}</p>
        </div>
      ) : !isSimulating ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3">
          <p className="text-xs text-text-secondary text-center">{t('previewHelper')}</p>
          <button
            onClick={startSimulation}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover transition text-sm font-medium"
          >
            <Play className="h-4 w-4" /> {t('previewWorkflow')}
          </button>
          <p className="text-[10px] text-text-muted text-center mt-1">
            {t('liveTestHelper')}
          </p>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {simStatus === 'running' && (
              <div className="text-center">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 font-medium">
                  {t('simulating')}
                </span>
              </div>
            )}
            {simStatus === 'complete' && (
              <div className="text-center">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 font-medium">
                  {t('simComplete')}
                </span>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : msg.role === 'system' ? 'justify-center' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
                  msg.role === 'user'
                    ? 'bg-primary text-white'
                    : msg.role === 'system'
                    ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 italic'
                    : 'bg-surface-hover text-text-primary'
                }`}>
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <div className="p-3 border-t border-border">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                placeholder={t('callerResponsePlaceholder')}
              />
              <button onClick={sendMessage} aria-label={t('sendMessage')} className="px-3 py-1.5 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover transition">
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DeploymentPanel({
  agentId,
  publishedVersion,
  versions,
  onPublish,
  onRollback,
  isPublishing,
  onClose,
  t,
}: {
  agentId: string;
  publishedVersion: number | null;
  versions: VersionInfo[];
  onPublish: () => void;
  onRollback: (version: number) => void;
  isPublishing: boolean;
  onClose: () => void;
  t: BuilderT;
}) {
  const navigate = useNavigate();
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [assigningPhone, setAssigningPhone] = useState(false);

  useEffect(() => {
    api.get<{ phoneNumbers: PhoneNumber[] }>('/phone-numbers').then((data) => {
      setPhoneNumbers(data.phoneNumbers || []);
    }).catch(() => {});
  }, []);

  const [phoneError, setPhoneError] = useState<string | null>(null);
  const assignedNumbers = phoneNumbers.filter((p) => p.routed_agent_id === agentId);
  const availableNumbers = phoneNumbers.filter((p) => !p.routed_agent_id);

  const assignPhone = async (phoneId: string) => {
    setAssigningPhone(true);
    setPhoneError(null);
    try {
      await api.patch(`/phone-numbers/${phoneId}/routing`, { agent_id: agentId });
      const data = await api.get<{ phoneNumbers: PhoneNumber[] }>('/phone-numbers');
      setPhoneNumbers(data.phoneNumbers || []);
    } catch (err) {
      setPhoneError(t('failedAssign', { message: (err as Error).message }));
    }
    setAssigningPhone(false);
  };

  const unassignPhone = async (phoneId: string) => {
    setAssigningPhone(true);
    setPhoneError(null);
    try {
      await api.patch(`/phone-numbers/${phoneId}/routing`, { agent_id: null });
      const data = await api.get<{ phoneNumbers: PhoneNumber[] }>('/phone-numbers');
      setPhoneNumbers(data.phoneNumbers || []);
    } catch (err) {
      setPhoneError(t('failedUnassign', { message: (err as Error).message }));
    }
    setAssigningPhone(false);
  };

  return (
    <div className="w-80 border-l border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <Rocket className="h-4 w-4" /> {t('deployment')}
        </h3>
        <button onClick={onClose} aria-label={t('close')} className="text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-3 space-y-4">
        <div>
          <button
            onClick={onPublish}
            disabled={isPublishing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover transition text-sm font-medium disabled:opacity-50"
          >
            <Rocket className="h-4 w-4" />
            {isPublishing ? t('publishing') : t('publishAgent')}
          </button>
          <p className="text-[10px] text-text-muted mt-1.5 text-center">
            {t('publishHelper')}
          </p>
          {publishedVersion && (
            <p className="text-[10px] text-text-secondary text-center mt-1">
              {t('currentLiveVersion', { version: publishedVersion })}
            </p>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <h4 className="text-xs font-semibold text-text-secondary mb-2 flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" /> {t('phoneNumbers')}
          </h4>
          {assignedNumbers.length > 0 ? (
            <div className="space-y-1.5 mb-2">
              {assignedNumbers.map((p) => (
                <div key={p.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20">
                  <div>
                    <p className="text-xs font-medium text-text-primary">{p.friendly_name || p.phone_number}</p>
                    <p className="text-[10px] text-text-muted">{p.phone_number}</p>
                  </div>
                  <button
                    onClick={() => unassignPhone(p.id)}
                    disabled={assigningPhone}
                    className="text-[10px] text-red-500 hover:text-red-700 font-medium disabled:opacity-50"
                  >
                    {t('remove')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted py-1 mb-2">{t('noNumbersAssigned')}</p>
          )}
          {phoneError && (
            <p className="text-xs text-red-500 py-1 mb-2">{phoneError}</p>
          )}
          {availableNumbers.length > 0 && (
            <select
              onChange={(e) => { if (e.target.value) assignPhone(e.target.value); e.target.value = ''; }}
              disabled={assigningPhone}
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-text-primary text-xs disabled:opacity-50"
              defaultValue=""
            >
              <option value="" disabled>{t('assignNumberPlaceholder')}</option>
              {availableNumbers.map((p) => (
                <option key={p.id} value={p.id}>{p.friendly_name || p.phone_number}</option>
              ))}
            </select>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <h4 className="text-xs font-semibold text-text-secondary mb-2 flex items-center gap-1.5">
            <History className="h-3.5 w-3.5" /> {t('versionHistory')}
          </h4>
          {versions.length === 0 ? (
            <p className="text-xs text-text-muted py-2">{t('noPublishedVersions')}</p>
          ) : (
            <div className="space-y-2">
              {versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-surface">
                  <div>
                    <p className="text-xs font-medium text-text-primary">v{v.version}</p>
                    <p className="text-[10px] text-text-muted">
                      {v.published_at ? new Date(v.published_at).toLocaleDateString() : 'Draft'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {publishedVersion === v.version && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        {t('liveBadge')}
                      </span>
                    )}
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      v.status === 'published'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-surface-hover text-text-secondary'
                    }`}>
                      v{v.version}
                    </span>
                    <button
                      onClick={() => onRollback(v.version)}
                      className="p-1 text-text-secondary hover:text-primary transition"
                      title={t('rollbackTitle')}
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <button
            onClick={() => navigate(`/analytics?agentId=${agentId}`)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-surface-hover hover:text-text-primary transition"
          >
            <Eye className="h-3.5 w-3.5" /> {t('viewAnalytics')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface CommandSuggestion {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

function CommandBar({
  isOpen,
  onClose,
  nodes,
  onAddNode,
  onConnectNodes,
  onFocusNode,
  t,
}: {
  isOpen: boolean;
  onClose: () => void;
  nodes: Node[];
  onAddNode: (nodeType: string) => void;
  onConnectNodes: (sourceId: string, targetId: string) => void;
  onFocusNode: (nodeId: string) => void;
  t: BuilderT;
}) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const library = useMemo(() => buildNodeLibrary(t), [t]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setActiveIdx(0);
      const id = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(id);
    }
  }, [isOpen]);

  const suggestions = useMemo<CommandSuggestion[]>(() => {
    const list: CommandSuggestion[] = [];
    const raw = query.trim();
    const q = raw.toLowerCase();

    if (q.startsWith('connect')) {
      const rest = raw.slice(7).trim();
      const restLower = rest.toLowerCase();
      const parts = restLower.split(/\s+to\s+/i);
      let sourceQ = '';
      let targetQ = '';
      if (parts.length === 2 && parts[0]) {
        sourceQ = parts[0].trim();
        targetQ = parts[1].trim();
      }

      const labelOf = (n: Node) => (n.data.label as string) || getNodeLabel((n.data.nodeType as string) || '', t) || n.id;

      for (const s of nodes) {
        const sLabel = labelOf(s);
        const sLower = sLabel.toLowerCase();
        if (sourceQ && !sLower.includes(sourceQ)) continue;
        for (const tgt of nodes) {
          if (s.id === tgt.id) continue;
          const tLabel = labelOf(tgt);
          const tLower = tLabel.toLowerCase();
          if (targetQ && !tLower.includes(targetQ)) continue;
          if (!sourceQ && !targetQ && restLower && !sLower.includes(restLower) && !tLower.includes(restLower)) continue;
          list.push({
            id: `connect-${s.id}-${tgt.id}`,
            label: t('cmdConnectNodes', { source: sLabel, target: tLabel }),
            action: () => { onConnectNodes(s.id, tgt.id); onClose(); },
          });
          if (list.length >= 30) break;
        }
        if (list.length >= 30) break;
      }
    } else {
      for (const cat of library) {
        for (const node of cat.nodes) {
          const label = t(node.labelKey);
          if (!q || label.toLowerCase().includes(q) || cat.label.toLowerCase().includes(q)) {
            list.push({
              id: `add-${node.type}`,
              label: t('cmdAddNode', { label }),
              hint: cat.label,
              action: () => { onAddNode(node.type); onClose(); },
            });
          }
        }
      }
      for (const n of nodes) {
        const label = (n.data.label as string) || getNodeLabel((n.data.nodeType as string) || '', t) || n.id;
        if (!q || label.toLowerCase().includes(q)) {
          list.push({
            id: `focus-${n.id}`,
            label: t('cmdFocusNode', { label }),
            action: () => { onFocusNode(n.id); onClose(); },
          });
        }
      }
    }

    return list.slice(0, 30);
  }, [query, library, nodes, t, onAddNode, onConnectNodes, onFocusNode, onClose]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(suggestions.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sug = suggestions[activeIdx];
      if (sug) sug.action();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-xl mx-4 bg-surface rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('commandBarTitle')}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search className="h-4 w-4 text-text-muted flex-shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-text-primary text-sm placeholder:text-text-muted focus:outline-none"
            placeholder={t('commandBarPlaceholder')}
            aria-label={t('commandBarTitle')}
            aria-controls="command-bar-listbox"
            aria-activedescendant={suggestions[activeIdx] ? `cmd-opt-${suggestions[activeIdx].id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div
          id="command-bar-listbox"
          ref={listRef}
          className="max-h-80 overflow-y-auto"
          role="listbox"
          aria-label={t('commandBarTitle')}
        >
          {suggestions.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-text-muted">{t('cmdNoMatches')}</p>
          ) : (
            suggestions.map((sug, idx) => (
              <button
                key={sug.id}
                id={`cmd-opt-${sug.id}`}
                data-idx={idx}
                type="button"
                role="option"
                aria-selected={idx === activeIdx}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => sug.action()}
                className={`w-full text-left px-4 py-2 flex items-center justify-between text-xs transition ${
                  idx === activeIdx ? 'bg-primary/10 text-text-primary' : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="truncate">{sug.label}</span>
                {sug.hint && <span className="text-[10px] text-text-muted ml-2 flex-shrink-0">{sug.hint}</span>}
              </button>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-border bg-surface-secondary space-y-0.5">
          <p className="text-[10px] text-text-muted">{t('commandBarHint')}</p>
          <p className="text-[10px] text-text-muted">{t('commandBarKeyboardHint')}</p>
        </div>
      </div>
    </div>
  );
}

function AgentBuilderInner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [rightPanel, setRightPanel] = useState<'none' | 'config' | 'voice' | 'test' | 'deploy' | 'improve'>('none');
  const [hasChanges, setHasChanges] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const [commandBarOpen, setCommandBarOpen] = useState(false);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);

  const [agentSettings, setAgentSettings] = useState({
    voice: 'alloy',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.7,
    system_prompt: '',
    welcome_greeting: '',
    name: '',
    language: DEFAULT_AGENT_LANGUAGE,
    tone: 'Professional',
    speakingRate: 1.0,
    workflow_id: '' as string,
  });

  const { data: workflowsData } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api.get<{ workflows: { id: string; name: string; description: string | null; steps: unknown[] }[] }>('/workflows?limit=100').catch(() => ({ workflows: [] })),
    retry: false,
  });

  const { data: agentData, isLoading } = useQuery({
    queryKey: ['agent', id],
    queryFn: () => api.get<{ agent: Agent }>(`/agents/${id}`),
    enabled: !!id && id !== 'new',
  });

  const { data: versionsData, refetch: refetchVersions } = useQuery({
    queryKey: ['agent-versions', id],
    queryFn: () => api.get<{ versions: VersionInfo[] }>(`/agents/${id}/versions`),
    enabled: !!id && id !== 'new',
  });

  useEffect(() => {
    if (agentData?.agent) {
      const a = agentData.agent;
      const wdSettings = (a.workflow_definition as unknown as Record<string, unknown>)?.settings as Record<string, unknown> | undefined;
      const lang = normalizeAgentLanguage(a.language ?? wdSettings?.language);
      const name = (wdSettings?.name as string) || a.name || '';
      const tone = (wdSettings?.tone as string) || 'Professional';
      const rawGreeting = (wdSettings?.welcome_greeting as string) ?? a.welcome_greeting ?? '';
      const rawPrompt = (wdSettings?.system_prompt as string) ?? a.system_prompt ?? '';
      setAgentSettings({
        voice: (wdSettings?.voice as string) || a.voice || 'alloy',
        model: (wdSettings?.model as string) || a.model || 'gpt-4o-realtime-preview',
        temperature: (wdSettings?.temperature as number) ?? a.temperature ?? 0.7,
        system_prompt: rawPrompt || getDefaultSystemPrompt(lang),
        welcome_greeting: rawGreeting || getDefaultWelcomeGreeting(lang),
        name,
        language: lang,
        tone,
        speakingRate: (wdSettings?.speakingRate as number) || 1.0,
        workflow_id: ((a as unknown as Record<string, unknown>).workflow_id as string) || '',
      });
      if (a.workflow_definition) {
        const wd = a.workflow_definition as unknown as Record<string, unknown>;
        setNodes((wd.nodes as WorkflowNode[]) || []);
        setEdges(
          ((wd.edges as WorkflowEdge[]) || []).map((e: WorkflowEdge) => ({
            ...e,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { strokeWidth: 2 },
          })),
        );
      }
    }
  }, [agentData, setNodes, setEdges]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (sourceNode && targetNode) {
        const srcType = (sourceNode.data.nodeType as string) || '';
        const tgtType = (targetNode.data.nodeType as string) || '';
        if (!isValidConnection(srcType, tgtType)) {
          setSaveMessage({
            text: makeBuilderT(agentSettings.language)('cannotConnect', {
              source: getNodeLabel(srcType, makeBuilderT(agentSettings.language)),
              target: getNodeLabel(tgtType, makeBuilderT(agentSettings.language)),
            }),
            tone: 'error',
          });
          setTimeout(() => setSaveMessage(null), 3000);
          return;
        }
      }
      if (connection.source === connection.target) return;
      setEdges((eds) =>
        addEdge(
          { ...connection, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 } },
          eds,
        ),
      );
      setHasChanges(true);
    },
    [setEdges, nodes, agentSettings.language],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow-type');
      const nodeType = event.dataTransfer.getData('application/reactflow-nodetype');
      if (!type || !nodeType) return;

      const bounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!bounds) return;

      const position = {
        x: event.clientX - bounds.left - 100,
        y: event.clientY - bounds.top - 30,
      };

      const newNode: Node = {
        id: `node_${Date.now()}`,
        type,
        position,
        data: { nodeType, label: getNodeLabel(nodeType, makeBuilderT(agentSettings.language)) },
      };
      setNodes((nds) => [...nds, newNode]);
      setHasChanges(true);
    },
    [setNodes, agentSettings.language],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedNode(node);
    setRightPanel('config');
  }, []);

  const updateNodeData = useCallback(
    (nodeId: string, newData: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: newData } : n)),
      );
      setSelectedNode((prev) => (prev && prev.id === nodeId ? { ...prev, data: newData } : prev));
      setHasChanges(true);
    },
    [setNodes],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNode(null);
      setRightPanel('none');
      setHasChanges(true);
    },
    [setNodes, setEdges],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const workflowDef = {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, label: e.label })),
        settings: {
          voice: agentSettings.voice,
          model: agentSettings.model,
          temperature: agentSettings.temperature,
          system_prompt: agentSettings.system_prompt,
          welcome_greeting: agentSettings.welcome_greeting,
          name: agentSettings.name,
          language: agentSettings.language,
          tone: agentSettings.tone,
          speakingRate: agentSettings.speakingRate,
        },
      };

      const payload: Record<string, unknown> = { workflow_definition: workflowDef };
      if (agentSettings.workflow_id) {
        payload.workflow_id = agentSettings.workflow_id;
      } else {
        payload.workflow_id = null;
      }
      await api.patch(`/agents/${id}/workflow`, payload);
    },
    onSuccess: () => {
      setHasChanges(false);
      setSaveMessage({ text: makeBuilderT(agentSettings.language)('saved'), tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['agent', id] });
      setTimeout(() => setSaveMessage(null), 2000);
    },
    onError: (err) => {
      setSaveMessage({
        text: makeBuilderT(agentSettings.language)('saveError', { message: (err as Error).message }),
        tone: 'error',
      });
      setTimeout(() => setSaveMessage(null), 3000);
    },
  });

  const publishMutation = useMutation({
    mutationFn: () => api.post(`/agents/${id}/publish`),
    onSuccess: () => {
      refetchVersions();
      setSaveMessage({ text: makeBuilderT(agentSettings.language)('published'), tone: 'success' });
      setTimeout(() => setSaveMessage(null), 2000);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (version: number) => api.post(`/agents/${id}/rollback`, { version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent', id] });
      refetchVersions();
      setSaveMessage({ text: makeBuilderT(agentSettings.language)('rolledBack'), tone: 'success' });
      setTimeout(() => setSaveMessage(null), 2000);
    },
  });

  const handleSettingChange = useCallback((key: string, value: string | number) => {
    setAgentSettings((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'language' && typeof value === 'string') {
        const newLang = value;
        if (!prev.welcome_greeting || isDefaultGreeting(prev.welcome_greeting)) {
          next.welcome_greeting = getDefaultWelcomeGreeting(newLang);
        }
        if (!prev.system_prompt || isDefaultSystemPrompt(prev.system_prompt)) {
          next.system_prompt = getDefaultSystemPrompt(newLang);
        }
      }
      return next;
    });
    setHasChanges(true);
  }, []);

  const t = useMemo(() => makeBuilderT(agentSettings.language), [agentSettings.language]);

  const industryTemplates = useMemo(() => buildIndustryTemplates(t), [t]);

  const loadTemplate = useCallback(
    (template: IndustryTemplate) => {
      setNodes(template.nodes);
      setEdges(
        template.edges.map((e) => ({
          ...e,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { strokeWidth: 2 },
        })),
      );
      setHasChanges(true);
    },
    [setNodes, setEdges],
  );

  const currentSelectedNode = useMemo(
    () => (selectedNode ? nodes.find((n) => n.id === selectedNode.id) || null : null),
    [selectedNode, nodes],
  );

  // Keep refs in sync so global keyboard handlers see the latest state
  // without re-binding the listener on every change.
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  const addNodeFromCommand = useCallback(
    (nodeType: string) => {
      const category = getNodeCategory(nodeType);
      const current = nodesRef.current;
      const selected = current.find((n) => n.selected);
      const basePos = selected
        ? { x: selected.position.x, y: selected.position.y + 150 }
        : { x: 250, y: 100 + current.length * 30 };
      const newId = `node_${Date.now()}`;
      const newNode: Node = {
        id: newId,
        type: category,
        position: basePos,
        data: { nodeType, label: getNodeLabel(nodeType, t) },
        selected: true,
      };
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), newNode]);
      setSelectedNode(newNode);
      setRightPanel('config');
      setHasChanges(true);
    },
    [setNodes, t],
  );

  const connectNodesById = useCallback(
    (sourceId: string, targetId: string) => {
      const current = nodesRef.current;
      const sourceNode = current.find((n) => n.id === sourceId);
      const targetNode = current.find((n) => n.id === targetId);
      if (!sourceNode || !targetNode || sourceId === targetId) return;
      const srcType = (sourceNode.data.nodeType as string) || '';
      const tgtType = (targetNode.data.nodeType as string) || '';
      if (!isValidConnection(srcType, tgtType)) {
        setSaveMessage({
          text: t('cannotConnect', {
            source: getNodeLabel(srcType, t),
            target: getNodeLabel(tgtType, t),
          }),
          tone: 'error',
        });
        setTimeout(() => setSaveMessage(null), 3000);
        return;
      }
      // Avoid duplicate edges between the same two endpoints.
      const exists = edgesRef.current.some(
        (e) => e.source === sourceId && e.target === targetId,
      );
      if (exists) return;
      setEdges((eds) =>
        addEdge(
          {
            source: sourceId,
            target: targetId,
            sourceHandle: null,
            targetHandle: null,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { strokeWidth: 2 },
          },
          eds,
        ),
      );
      setHasChanges(true);
    },
    [setEdges, t],
  );

  const focusNodeById = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })));
      const target = nodesRef.current.find((n) => n.id === nodeId);
      if (target) {
        setSelectedNode({ ...target, selected: true });
        setRightPanel('config');
      }
    },
    [setNodes],
  );

  // Global keyboard handlers for the builder canvas:
  //   - Cmd/Ctrl+K or "/"  → open command palette
  //   - Esc                → close command palette / right panel
  //   - Arrow keys         → nudge currently selected node (Shift = larger step)
  // We intentionally ignore key events when the user is typing in a form field
  // so we don't fight inputs/textareas inside the side panels.
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable) return true;
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Open command palette
      const isModK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isModK) {
        e.preventDefault();
        setCommandBarOpen(true);
        return;
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
        e.preventDefault();
        setCommandBarOpen(true);
        return;
      }

      // Esc: close command palette first, otherwise collapse the right panel.
      // The palette has its own local Esc handler when its input has focus;
      // this global one is the fallback when focus is elsewhere.
      if (e.key === 'Escape' && !isEditableTarget(e.target)) {
        setCommandBarOpen((open) => {
          if (open) return false;
          setRightPanel((panel) => (panel === 'none' ? panel : 'none'));
          return open;
        });
        return;
      }

      if (isEditableTarget(e.target)) return;

      // Move selected nodes with arrow keys
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const selected = nodesRef.current.filter((n) => n.selected);
        if (selected.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 50 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        setNodes((nds) =>
          nds.map((n) =>
            n.selected
              ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
              : n,
          ),
        );
        setHasChanges(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setNodes]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-text-secondary">{t('loadingAgent')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface z-10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/dashboard')}
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition"
          >
            <ArrowLeft className="h-4 w-4" /> {t('back')}
          </button>
          <div className="h-5 w-px bg-border" />
          <div>
            <input
              value={agentSettings.name}
              onChange={(e) => handleSettingChange('name', e.target.value)}
              className="text-sm font-semibold text-text-primary bg-transparent border-none focus:outline-none focus:ring-0 px-0"
              placeholder={t('agentNamePlaceholder')}
            />
          </div>
          {hasChanges && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium">
              {t('unsaved')}
            </span>
          )}
          {saveMessage && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              saveMessage.tone === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            }`}>
              {saveMessage.text}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCommandBarOpen(true)}
            aria-label={t('commandBarOpen')}
            title={t('commandBarOpen')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary border border-border rounded-lg hover:bg-surface-hover transition"
          >
            <Keyboard className="h-3.5 w-3.5" />
            <span>{t('keyboardShortcutsLabel')}</span>
            <kbd className="ml-1 hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-border bg-surface-secondary text-[10px] font-mono text-text-muted">
              ⌘K
            </kbd>
          </button>
          <div className="relative group">
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary border border-border rounded-lg hover:bg-surface-hover transition">
              <Eye className="h-3.5 w-3.5" /> {t('templates')}
            </button>
            <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-border rounded-lg shadow-lg z-20 hidden group-hover:block">
              {industryTemplates.map((tpl) => (
                <button
                  key={tpl.key}
                  onClick={() => loadTemplate(tpl)}
                  className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-surface-hover transition first:rounded-t-lg last:rounded-b-lg"
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => setRightPanel(rightPanel === 'voice' ? 'none' : 'voice')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition ${
              rightPanel === 'voice' ? 'border-primary text-primary bg-primary/5' : 'border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            <Settings2 className="h-3.5 w-3.5" /> {t('voice')}
          </button>
          <button
            onClick={() => setRightPanel(rightPanel === 'test' ? 'none' : 'test')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition ${
              rightPanel === 'test' ? 'border-primary text-primary bg-primary/5' : 'border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            <Play className="h-3.5 w-3.5" /> {t('test')}
          </button>
          <button
            onClick={() => setRightPanel(rightPanel === 'improve' ? 'none' : 'improve')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition ${
              rightPanel === 'improve' ? 'border-amber-500 text-amber-600 bg-amber-50 dark:bg-amber-900/20' : 'border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            <Lightbulb className="h-3.5 w-3.5" /> {t('improve')}
          </button>
          <TooltipWalkthrough
            tooltipKey="builder-deploy"
            title={t('deployTooltipTitle')}
            description={t('deployTooltipDesc')}
            position="bottom"
          >
            <button
              onClick={() => {
                setRightPanel(rightPanel === 'deploy' ? 'none' : 'deploy');
                refetchVersions();
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition ${
                rightPanel === 'deploy' ? 'border-primary text-primary bg-primary/5' : 'border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              <Rocket className="h-3.5 w-3.5" /> {t('deploy')}
            </button>
          </TooltipWalkthrough>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !hasChanges}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saveMutation.isPending ? t('saving') : t('save')}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <NodeLibrarySidebar onDragStart={() => {}} t={t} />

        <div className="flex-1 relative" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => { onNodesChange(changes); setHasChanges(true); }}
            onEdgesChange={(changes) => { onEdgesChange(changes); setHasChanges(true); }}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onPaneClick={() => { setSelectedNode(null); if (rightPanel === 'config') setRightPanel('none'); }}
            nodeTypes={nodeTypes}
            fitView
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed },
              style: { strokeWidth: 2 },
            }}
            className="bg-surface-secondary"
          >
            <Background gap={20} size={1} />
            <Controls className="!bg-surface !border-border !shadow-sm" />
            <MiniMap
              className="!bg-surface !border-border"
              nodeColor={(node) => {
                const nt = (node.data?.nodeType as string) || '';
                return NODE_COLORS[nt]?.handle || '#6b7280';
              }}
            />
            {nodes.length === 0 && (
              <Panel position="top-center">
                <div className="bg-surface border border-border rounded-xl shadow-sm px-6 py-4 text-center mt-20">
                  <p className="text-sm text-text-primary font-medium mb-1">{t('startBuilding')}</p>
                  <p className="text-xs text-text-secondary mb-3">
                    {t('startBuildingHelper')}
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {industryTemplates.map((tpl) => (
                      <button
                        key={tpl.key}
                        onClick={() => loadTemplate(tpl)}
                        className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-surface-hover hover:border-primary/50 transition text-text-primary"
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>

        {rightPanel === 'config' && currentSelectedNode && (
          <NodeConfigPanel
            node={currentSelectedNode}
            onUpdate={updateNodeData}
            onDelete={deleteNode}
            onClose={() => { setRightPanel('none'); setSelectedNode(null); }}
            t={t}
          />
        )}
        {rightPanel === 'voice' && (
          <VoiceConfigPanel
            voice={agentSettings.voice}
            model={agentSettings.model}
            temperature={agentSettings.temperature}
            systemPrompt={agentSettings.system_prompt}
            welcomeGreeting={agentSettings.welcome_greeting}
            language={agentSettings.language}
            tone={agentSettings.tone}
            speakingRate={agentSettings.speakingRate}
            workflowId={agentSettings.workflow_id}
            workflows={workflowsData?.workflows ?? []}
            onChange={handleSettingChange}
            onClose={() => setRightPanel('none')}
            t={t}
          />
        )}
        {rightPanel === 'test' && (
          <TestConsolePanel
            agentName={agentSettings.name}
            welcomeGreeting={agentSettings.welcome_greeting}
            language={agentSettings.language}
            nodes={nodes}
            edges={edges}
            onClose={() => setRightPanel('none')}
            t={t}
          />
        )}
        {rightPanel === 'deploy' && (
          <DeploymentPanel
            agentId={id || ''}
            publishedVersion={agentData?.agent?.published_version ?? null}
            versions={versionsData?.versions || []}
            onPublish={() => publishMutation.mutate()}
            onRollback={(version) => {
              if (confirm(t('rollbackConfirm', { version }))) {
                rollbackMutation.mutate(version);
              }
            }}
            isPublishing={publishMutation.isPending}
            onClose={() => setRightPanel('none')}
            t={t}
          />
        )}
        {rightPanel === 'improve' && (
          <ImprovementSuggestionsPanel
            agentId={id || ''}
            onClose={() => setRightPanel('none')}
            t={t}
          />
        )}
      </div>
      <CommandBar
        isOpen={commandBarOpen}
        onClose={() => setCommandBarOpen(false)}
        nodes={nodes}
        onAddNode={addNodeFromCommand}
        onConnectNodes={connectNodesById}
        onFocusNode={focusNodeById}
        t={t}
      />
    </div>
  );
}

export default function AgentBuilder() {
  return (
    <ReactFlowProvider>
      <AgentBuilderInner />
    </ReactFlowProvider>
  );
}
