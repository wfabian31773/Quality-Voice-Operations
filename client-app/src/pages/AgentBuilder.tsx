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
  ArrowLeft, Save, Play, Rocket, History, GripVertical,
  MessageSquare, HelpCircle, CheckCircle, GitBranch, Route,
  Ticket, UserPlus, Calendar, Send, Truck, Phone,
  X, ChevronDown, ChevronRight, Mic, Settings2, Zap,
  RotateCcw, Eye, Trash2,
} from 'lucide-react';
import TooltipWalkthrough from '../components/TooltipWalkthrough';

interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
  voice: string;
  model: string;
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
  icon: React.ReactNode;
  nodes: { type: string; label: string; icon: React.ReactNode; description: string }[];
}

const NODE_LIBRARY: NodeCategory[] = [
  {
    label: 'Conversation',
    icon: <MessageSquare className="h-4 w-4" />,
    nodes: [
      { type: 'greeting', label: 'Greeting', icon: <Phone className="h-4 w-4" />, description: 'Welcome the caller' },
      { type: 'askQuestion', label: 'Ask Question', icon: <HelpCircle className="h-4 w-4" />, description: 'Collect information' },
      { type: 'confirmInfo', label: 'Confirm Info', icon: <CheckCircle className="h-4 w-4" />, description: 'Verify collected data' },
    ],
  },
  {
    label: 'Logic',
    icon: <GitBranch className="h-4 w-4" />,
    nodes: [
      { type: 'condition', label: 'Condition / If', icon: <GitBranch className="h-4 w-4" />, description: 'Branch on condition' },
      { type: 'routeDecision', label: 'Route Decision', icon: <Route className="h-4 w-4" />, description: 'Route to department' },
    ],
  },
  {
    label: 'Action',
    icon: <Zap className="h-4 w-4" />,
    nodes: [
      { type: 'createTicket', label: 'Create Ticket', icon: <Ticket className="h-4 w-4" />, description: 'Create service ticket' },
      { type: 'createContact', label: 'Create Contact', icon: <UserPlus className="h-4 w-4" />, description: 'Add to CRM' },
      { type: 'scheduleAppt', label: 'Schedule Appointment', icon: <Calendar className="h-4 w-4" />, description: 'Book appointment' },
      { type: 'sendSms', label: 'Send SMS', icon: <Send className="h-4 w-4" />, description: 'Send text message' },
      { type: 'dispatchJob', label: 'Dispatch Job', icon: <Truck className="h-4 w-4" />, description: 'Assign dispatch job' },
    ],
  },
];

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

const DEFAULT_COLORS = { bg: 'bg-gray-50 dark:bg-gray-800', border: 'border-gray-300 dark:border-gray-600', text: 'text-gray-700 dark:text-gray-300', handle: '#6b7280' };

function getNodeIcon(type: string) {
  for (const cat of NODE_LIBRARY) {
    for (const n of cat.nodes) {
      if (n.type === type) return n.icon;
    }
  }
  return <MessageSquare className="h-4 w-4" />;
}

function getNodeLabel(type: string) {
  for (const cat of NODE_LIBRARY) {
    for (const n of cat.nodes) {
      if (n.type === type) return n.label;
    }
  }
  return type;
}

function ConversationNode({ data, selected }: { data: Record<string, unknown>; selected: boolean }) {
  const nodeType = (data.nodeType as string) || 'greeting';
  const colors = NODE_COLORS[nodeType] || DEFAULT_COLORS;
  const label = (data.label as string) || getNodeLabel(nodeType);
  const prompt = (data.prompt as string) || '';

  return (
    <div className={`rounded-xl border-2 ${colors.border} ${colors.bg} shadow-sm min-w-[200px] max-w-[260px] transition-shadow ${selected ? 'shadow-lg ring-2 ring-primary/30' : ''}`}>
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
    <div className={`rounded-xl border-2 ${colors.border} ${colors.bg} shadow-sm min-w-[200px] max-w-[260px] transition-shadow ${selected ? 'shadow-lg ring-2 ring-primary/30' : ''}`}
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
    <div className={`rounded-xl border-2 ${colors.border} ${colors.bg} shadow-sm min-w-[200px] max-w-[260px] transition-shadow ${selected ? 'shadow-lg ring-2 ring-primary/30' : ''}`}>
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

const INDUSTRY_TEMPLATES: { label: string; key: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] }[] = [
  {
    label: 'Medical After-Hours',
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
    label: 'Dental Office',
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
    label: 'HVAC / Home Services',
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
    label: 'Legal Intake',
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
    label: 'Customer Support',
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

function NodeLibrarySidebar({ onDragStart }: { onDragStart: (type: string, nodeType: string) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ Conversation: true, Logic: true, Action: true });

  return (
    <div className="w-60 border-r border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">Node Library</h3>
        <p className="text-xs text-text-secondary mt-0.5">Drag nodes onto the canvas</p>
      </div>
      {NODE_LIBRARY.map((cat) => (
        <div key={cat.label}>
          <button
            onClick={() => setExpanded((e) => ({ ...e, [cat.label]: !e[cat.label] }))}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wider hover:bg-surface-hover transition"
          >
            {expanded[cat.label] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {cat.icon}
            {cat.label}
          </button>
          {expanded[cat.label] && (
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
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-white dark:bg-gray-800 hover:border-primary/50 hover:shadow-sm cursor-grab active:cursor-grabbing transition text-sm"
                >
                  <GripVertical className="h-3 w-3 text-text-muted flex-shrink-0" />
                  <span className={NODE_COLORS[node.type]?.text || 'text-text-primary'}>{node.icon}</span>
                  <div className="min-w-0">
                    <p className="text-text-primary font-medium text-xs">{node.label}</p>
                    <p className="text-text-muted text-[10px] truncate">{node.description}</p>
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
}: {
  node: Node;
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const nodeType = (node.data.nodeType as string) || '';
  const category = getNodeCategory(nodeType);

  return (
    <div className="w-80 border-l border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">Node Configuration</h3>
        <button onClick={onClose} className="text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-3 space-y-4">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Label</label>
          <input
            value={(node.data.label as string) || ''}
            onChange={(e) => onUpdate(node.id, { ...node.data, label: e.target.value })}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {category === 'conversation' && (
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Prompt / Instructions</label>
            <textarea
              value={(node.data.prompt as string) || ''}
              onChange={(e) => onUpdate(node.id, { ...node.data, prompt: e.target.value })}
              rows={6}
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
              placeholder="What should the agent say or ask at this step?"
            />
          </div>
        )}

        {category === 'logic' && (
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Condition Expression</label>
            <input
              value={(node.data.conditionField as string) || ''}
              onChange={(e) => onUpdate(node.id, { ...node.data, conditionField: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder='e.g., urgency === "high"'
            />
            <p className="text-[10px] text-text-muted mt-1">
              Yes exits from left handle, No exits from right handle.
            </p>
          </div>
        )}

        {category === 'action' && (
          <>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Tool</label>
              <div className="px-3 py-1.5 rounded-lg border border-border bg-gray-50 dark:bg-gray-800 text-text-primary text-sm">
                {getNodeLabel(nodeType)}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Configuration</label>
              <textarea
                value={(node.data.toolConfig as string) || ''}
                onChange={(e) => onUpdate(node.id, { ...node.data, toolConfig: e.target.value })}
                rows={4}
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
                placeholder="Tool-specific configuration..."
              />
            </div>
          </>
        )}

        <div className="pt-2 border-t border-border">
          <button
            onClick={() => onDelete(node.id)}
            className="flex items-center gap-1.5 text-xs font-medium text-danger hover:text-red-700 transition"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete Node
          </button>
        </div>
      </div>
    </div>
  );
}

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Chinese', 'Japanese', 'Korean', 'Arabic', 'Hindi'];
const TONE_OPTIONS = ['Professional', 'Friendly', 'Casual', 'Empathetic', 'Formal', 'Warm', 'Direct'];

function VoiceConfigPanel({
  voice,
  model,
  temperature,
  systemPrompt,
  welcomeGreeting,
  language,
  tone,
  speakingRate,
  onChange,
  onClose,
}: {
  voice: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  welcomeGreeting: string;
  language: string;
  tone: string;
  speakingRate: number;
  onChange: (key: string, value: string | number) => void;
  onClose: () => void;
}) {
  return (
    <div className="w-80 border-l border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <Mic className="h-4 w-4" /> Voice & Agent Config
        </h3>
        <button onClick={onClose} className="text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-3 space-y-4">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Voice</label>
          <select
            value={voice}
            onChange={(e) => onChange('voice', e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm"
          >
            {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Model</label>
          <select
            value={model}
            onChange={(e) => onChange('model', e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm"
          >
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Language</label>
          <select
            value={language}
            onChange={(e) => onChange('language', e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm"
          >
            {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Tone / Personality</label>
          <select
            value={tone}
            onChange={(e) => onChange('tone', e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm"
          >
            {TONE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Temperature: {temperature}</label>
          <input
            type="range" min="0" max="1" step="0.1" value={temperature}
            onChange={(e) => onChange('temperature', parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-text-muted mt-0.5">
            <span>Precise</span>
            <span>Creative</span>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Speaking Rate: {speakingRate}x</label>
          <input
            type="range" min="0.5" max="2.0" step="0.1" value={speakingRate}
            onChange={(e) => onChange('speakingRate', parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-text-muted mt-0.5">
            <span>Slower</span>
            <span>Faster</span>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Welcome Greeting</label>
          <textarea
            value={welcomeGreeting}
            onChange={(e) => onChange('welcome_greeting', e.target.value)}
            rows={3}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
            placeholder="First thing the agent says..."
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">System Prompt</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => onChange('system_prompt', e.target.value)}
            rows={10}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
            placeholder="Agent personality, instructions, and rules..."
          />
          <p className="text-[10px] text-text-muted mt-1">
            On publish, the workflow steps will be appended to this prompt automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

function TestConsolePanel({
  agentName,
  welcomeGreeting,
  nodes,
  edges,
  onClose,
}: {
  agentName: string;
  welcomeGreeting: string;
  nodes: Node[];
  edges: Edge[];
  onClose: () => void;
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
    const label = (node.data.label as string) || getNodeLabel(nodeType);
    const category = getNodeCategory(nodeType);

    setCurrentNodeId(node.id);

    if (category === 'conversation') {
      const prompt = (node.data.prompt as string) || '';
      const agentText = prompt || `[${label}] — Agent step executing...`;
      setMessages((prev) => [...prev, { role: 'agent', text: agentText, nodeId: node.id }]);
    } else if (category === 'logic') {
      const field = (node.data.conditionField as string) || 'condition';
      setMessages((prev) => [...prev, { role: 'system', text: `Evaluating: ${field}`, nodeId: node.id }]);
      setTimeout(() => {
        const yesPath = getNextNodes(node.id, 'yes');
        if (yesPath.length > 0 && yesPath[0].node) {
          setMessages((prev) => [...prev, { role: 'system', text: `Branch: ${yesPath[0].label || 'Yes'}` }]);
          simulateNode(yesPath[0].node);
        }
      }, 800);
    } else if (category === 'action') {
      const config = (node.data.toolConfig as string) || '';
      setMessages((prev) => [...prev, { role: 'system', text: `Executing: ${label}${config ? ` — ${config}` : ''}`, nodeId: node.id }]);
      setTimeout(() => {
        setMessages((prev) => [...prev, { role: 'system', text: `${label} completed successfully` }]);
        const next = getNextNodes(node.id);
        if (next.length > 0 && next[0].node) {
          simulateNode(next[0].node);
        } else {
          setSimStatus('complete');
          setMessages((prev) => [...prev, { role: 'system', text: 'Workflow simulation complete.' }]);
        }
      }, 1000);
    }
  }, [getNextNodes]);

  const startSimulation = useCallback(() => {
    setIsSimulating(true);
    setSimStatus('running');
    setMessages([]);

    const greeting = welcomeGreeting || `Hello! This is ${agentName}. How can I help you today?`;
    setMessages([{ role: 'agent', text: greeting }]);

    const startNode = findStartNode();
    if (startNode) {
      setTimeout(() => simulateNode(startNode), 500);
    }
  }, [agentName, welcomeGreeting, findStartNode, simulateNode]);

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
        setMessages((prev) => [...prev, { role: 'system', text: 'End of workflow. No further steps defined.' }]);
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
          <Play className="h-4 w-4" /> Test Console
        </h3>
        <div className="flex items-center gap-1">
          {isSimulating && (
            <button onClick={resetSimulation} className="text-text-secondary hover:text-primary text-xs px-1.5 py-0.5 rounded hover:bg-surface-hover transition">
              Reset
            </button>
          )}
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {nodes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-text-muted text-center">Add nodes to the workflow to test the agent flow.</p>
        </div>
      ) : !isSimulating ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3">
          <p className="text-xs text-text-secondary text-center">Preview the call flow by walking through your workflow nodes step by step.</p>
          <button
            onClick={startSimulation}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover transition text-sm font-medium"
          >
            <Play className="h-4 w-4" /> Preview Workflow
          </button>
          <p className="text-[10px] text-text-muted text-center mt-1">
            For a live voice test, publish the agent, assign a phone number, and call it.
          </p>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {simStatus === 'running' && (
              <div className="text-center">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 font-medium">
                  Simulating call
                </span>
              </div>
            )}
            {simStatus === 'complete' && (
              <div className="text-center">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 font-medium">
                  Simulation complete
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
                    : 'bg-gray-100 dark:bg-gray-800 text-text-primary'
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
                className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                placeholder="Type a caller response..."
              />
              <button onClick={sendMessage} className="px-3 py-1.5 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover transition">
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
}: {
  agentId: string;
  publishedVersion: number | null;
  versions: VersionInfo[];
  onPublish: () => void;
  onRollback: (version: number) => void;
  isPublishing: boolean;
  onClose: () => void;
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
      setPhoneError(`Failed to assign: ${(err as Error).message}`);
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
      setPhoneError(`Failed to unassign: ${(err as Error).message}`);
    }
    setAssigningPhone(false);
  };

  return (
    <div className="w-80 border-l border-border bg-surface overflow-y-auto flex-shrink-0">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <Rocket className="h-4 w-4" /> Deployment
        </h3>
        <button onClick={onClose} className="text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-3 space-y-4">
        <div>
          <button
            onClick={onPublish}
            disabled={isPublishing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover transition text-sm font-medium disabled:opacity-50"
          >
            <Rocket className="h-4 w-4" />
            {isPublishing ? 'Publishing...' : 'Publish Agent'}
          </button>
          <p className="text-[10px] text-text-muted mt-1.5 text-center">
            Promotes the current draft to a live published version.
          </p>
          {publishedVersion && (
            <p className="text-[10px] text-text-secondary text-center mt-1">
              Current live version: v{publishedVersion}
            </p>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <h4 className="text-xs font-semibold text-text-secondary mb-2 flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" /> Phone Numbers
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
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted py-1 mb-2">No phone numbers assigned. Assign a number to receive calls.</p>
          )}
          {phoneError && (
            <p className="text-xs text-red-500 py-1 mb-2">{phoneError}</p>
          )}
          {availableNumbers.length > 0 && (
            <select
              onChange={(e) => { if (e.target.value) assignPhone(e.target.value); e.target.value = ''; }}
              disabled={assigningPhone}
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-xs disabled:opacity-50"
              defaultValue=""
            >
              <option value="" disabled>Assign a phone number...</option>
              {availableNumbers.map((p) => (
                <option key={p.id} value={p.id}>{p.friendly_name || p.phone_number}</option>
              ))}
            </select>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <h4 className="text-xs font-semibold text-text-secondary mb-2 flex items-center gap-1.5">
            <History className="h-3.5 w-3.5" /> Version History
          </h4>
          {versions.length === 0 ? (
            <p className="text-xs text-text-muted py-2">No published versions yet.</p>
          ) : (
            <div className="space-y-2">
              {versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-white dark:bg-gray-800">
                  <div>
                    <p className="text-xs font-medium text-text-primary">v{v.version}</p>
                    <p className="text-[10px] text-text-muted">
                      {v.published_at ? new Date(v.published_at).toLocaleDateString() : 'Draft'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {publishedVersion === v.version && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        live
                      </span>
                    )}
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      v.status === 'published'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                    }`}>
                      v{v.version}
                    </span>
                    <button
                      onClick={() => onRollback(v.version)}
                      className="p-1 text-text-secondary hover:text-primary transition"
                      title="Rollback to this version"
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
            <Eye className="h-3.5 w-3.5" /> View Agent Analytics
          </button>
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
  const [rightPanel, setRightPanel] = useState<'none' | 'config' | 'voice' | 'test' | 'deploy'>('none');
  const [hasChanges, setHasChanges] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [agentSettings, setAgentSettings] = useState({
    voice: 'alloy',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.7,
    system_prompt: '',
    welcome_greeting: '',
    name: '',
    language: 'English',
    tone: 'Professional',
    speakingRate: 1.0,
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
      setAgentSettings({
        voice: (wdSettings?.voice as string) || a.voice || 'alloy',
        model: (wdSettings?.model as string) || a.model || 'gpt-4o-realtime-preview',
        temperature: (wdSettings?.temperature as number) ?? a.temperature ?? 0.7,
        system_prompt: (wdSettings?.system_prompt as string) ?? a.system_prompt ?? '',
        welcome_greeting: (wdSettings?.welcome_greeting as string) ?? a.welcome_greeting ?? '',
        name: (wdSettings?.name as string) || a.name || '',
        language: (wdSettings?.language as string) || 'English',
        tone: (wdSettings?.tone as string) || 'Professional',
        speakingRate: (wdSettings?.speakingRate as number) || 1.0,
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
          setSaveMessage(`Cannot connect ${getNodeLabel(srcType)} to ${getNodeLabel(tgtType)}`);
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
    [setEdges, nodes],
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
        data: { nodeType, label: getNodeLabel(nodeType) },
      };
      setNodes((nds) => [...nds, newNode]);
      setHasChanges(true);
    },
    [setNodes],
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

      await api.patch(`/agents/${id}/workflow`, { workflow_definition: workflowDef });
    },
    onSuccess: () => {
      setHasChanges(false);
      setSaveMessage('Saved');
      queryClient.invalidateQueries({ queryKey: ['agent', id] });
      setTimeout(() => setSaveMessage(null), 2000);
    },
    onError: (err) => {
      setSaveMessage(`Error: ${(err as Error).message}`);
      setTimeout(() => setSaveMessage(null), 3000);
    },
  });

  const publishMutation = useMutation({
    mutationFn: () => api.post(`/agents/${id}/publish`),
    onSuccess: () => {
      refetchVersions();
      setSaveMessage('Published!');
      setTimeout(() => setSaveMessage(null), 2000);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (version: number) => api.post(`/agents/${id}/rollback`, { version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent', id] });
      refetchVersions();
      setSaveMessage('Rolled back successfully');
      setTimeout(() => setSaveMessage(null), 2000);
    },
  });

  const handleSettingChange = useCallback((key: string, value: string | number) => {
    setAgentSettings((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  }, []);

  const loadTemplate = useCallback(
    (template: typeof INDUSTRY_TEMPLATES[0]) => {
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-text-secondary">Loading agent...</div>
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
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="h-5 w-px bg-border" />
          <div>
            <input
              value={agentSettings.name}
              onChange={(e) => handleSettingChange('name', e.target.value)}
              className="text-sm font-semibold text-text-primary bg-transparent border-none focus:outline-none focus:ring-0 px-0"
              placeholder="Agent Name"
            />
          </div>
          {hasChanges && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium">
              Unsaved
            </span>
          )}
          {saveMessage && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              saveMessage.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            }`}>
              {saveMessage}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative group">
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary border border-border rounded-lg hover:bg-surface-hover transition">
              <Eye className="h-3.5 w-3.5" /> Templates
            </button>
            <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-border rounded-lg shadow-lg z-20 hidden group-hover:block">
              {INDUSTRY_TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => loadTemplate(t)}
                  className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-surface-hover transition first:rounded-t-lg last:rounded-b-lg"
                >
                  {t.label}
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
            <Settings2 className="h-3.5 w-3.5" /> Voice
          </button>
          <button
            onClick={() => setRightPanel(rightPanel === 'test' ? 'none' : 'test')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition ${
              rightPanel === 'test' ? 'border-primary text-primary bg-primary/5' : 'border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            <Play className="h-3.5 w-3.5" /> Test
          </button>
          <TooltipWalkthrough
            tooltipKey="builder-deploy"
            title="Deploy Your Agent"
            description="When your workflow is ready, click Deploy to publish your agent. Published agents go live immediately and can start handling calls."
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
              <Rocket className="h-3.5 w-3.5" /> Deploy
            </button>
          </TooltipWalkthrough>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !hasChanges}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <NodeLibrarySidebar onDragStart={() => {}} />

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
            className="bg-gray-50 dark:bg-gray-900"
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
                  <p className="text-sm text-text-primary font-medium mb-1">Start building your agent workflow</p>
                  <p className="text-xs text-text-secondary mb-3">
                    Drag nodes from the library, or start from a template.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {INDUSTRY_TEMPLATES.map((t) => (
                      <button
                        key={t.key}
                        onClick={() => loadTemplate(t)}
                        className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-surface-hover hover:border-primary/50 transition text-text-primary"
                      >
                        {t.label}
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
            onChange={handleSettingChange}
            onClose={() => setRightPanel('none')}
          />
        )}
        {rightPanel === 'test' && (
          <TestConsolePanel
            agentName={agentSettings.name}
            welcomeGreeting={agentSettings.welcome_greeting}
            nodes={nodes}
            edges={edges}
            onClose={() => setRightPanel('none')}
          />
        )}
        {rightPanel === 'deploy' && (
          <DeploymentPanel
            agentId={id || ''}
            publishedVersion={agentData?.agent?.published_version ?? null}
            versions={versionsData?.versions || []}
            onPublish={() => publishMutation.mutate()}
            onRollback={(version) => {
              if (confirm(`Rollback to version ${version}? This will overwrite the current draft and set it as the live version.`)) {
                rollbackMutation.mutate(version);
              }
            }}
            isPublishing={publishMutation.isPending}
            onClose={() => setRightPanel('none')}
          />
        )}
      </div>
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
