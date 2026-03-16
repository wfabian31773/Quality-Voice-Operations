import { useState, useEffect, useRef, useCallback } from 'react';
import type { TranscriptMessage } from '../components/demo/ConversationTranscript';
import type { ToolExecution } from '../components/demo/ToolExecutionPanel';
import type { ActivityEvent } from '../components/demo/SystemActivityFeed';
import type { CallStatus } from '../components/demo/CallStatusIndicator';

const API_BASE = '/api';

interface ActiveDemoCall {
  callId: string;
  state: string;
  agentName: string | null;
  startTime: string;
}

interface DemoSSEState {
  callStatus: CallStatus;
  activeCallId: string | null;
  agentName: string | null;
  duration: number | null;
  transcript: TranscriptMessage[];
  tools: ToolExecution[];
  activityEvents: ActivityEvent[];
  connected: boolean;
}

function lifecycleToCallStatus(state: string): CallStatus {
  switch (state) {
    case 'CALL_RECEIVED':
    case 'SESSION_INITIALIZED':
      return 'ringing';
    case 'AGENT_CONNECTED':
    case 'ACTIVE_CONVERSATION':
    case 'WORKFLOW_EXECUTION':
    case 'TOOL_EXECUTION':
    case 'ESCALATION_CHECK':
    case 'ESCALATED':
      return 'connected';
    case 'CALL_COMPLETED':
    case 'CALL_FAILED':
    case 'WORKFLOW_FAILED':
    case 'ESCALATION_FAILED':
      return 'ended';
    default:
      return 'idle';
  }
}

let msgCounter = 0;
let toolCounter = 0;

export function useDemoSSE(): DemoSSEState {
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [tools, setTools] = useState<ToolExecution[]>([]);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeCallIdRef = useRef<string | null>(null);

  const connectToCall = useCallback((callId: string) => {
    if (esRef.current) {
      esRef.current.close();
    }

    activeCallIdRef.current = callId;
    setActiveCallId(callId);
    setTranscript([]);
    setTools([]);
    setActivityEvents([]);

    const es = new EventSource(`${API_BASE}/demo/live/${callId}`);
    esRef.current = es;

    es.addEventListener('call_state', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const status = lifecycleToCallStatus(data.state);
        setCallStatus(status);
        setAgentName(data.agentName ?? null);
        setDuration(data.durationSeconds ?? null);
      } catch {}
    });

    es.addEventListener('transcript', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const msg: TranscriptMessage = {
          id: `msg-${++msgCounter}`,
          speaker: data.speaker,
          text: data.text,
          timestamp: data.timestamp,
        };
        setTranscript((prev) => [...prev, msg]);
      } catch {}
    });

    es.addEventListener('tool_start', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const toolExec: ToolExecution = {
          id: data.invocationId ?? `tool-${++toolCounter}`,
          tool: data.tool,
          status: 'running',
          startedAt: data.timestamp,
        };
        setTools((prev) => [...prev, toolExec]);
      } catch {}
    });

    es.addEventListener('tool_end', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const pairedId = data.pairedStartId;
        setTools((prev) =>
          prev.map((t) => {
            if (pairedId && t.id === pairedId && t.status === 'running') {
              return { ...t, status: 'completed' as const, completedAt: data.timestamp };
            }
            if (!pairedId && t.tool === data.tool && t.status === 'running') {
              return { ...t, status: 'completed' as const, completedAt: data.timestamp };
            }
            return t;
          }),
        );
      } catch {}
    });

    es.addEventListener('activity', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const actEvent: ActivityEvent = {
          id: data.id,
          eventType: data.eventType,
          fromState: data.fromState,
          toState: data.toState,
          payload: data.payload,
          timestamp: data.timestamp,
        };
        setActivityEvents((prev) => {
          if (prev.some((e) => e.id === actEvent.id)) return prev;
          return [...prev, actEvent];
        });
      } catch {}
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
    };
  }, []);

  const pollForActiveCalls = useCallback(async () => {
    if (activeCallIdRef.current) return;

    try {
      const res = await fetch(`${API_BASE}/demo/active-call`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.activeCalls && data.activeCalls.length > 0) {
        const call: ActiveDemoCall = data.activeCalls[0];
        connectToCall(call.callId);
        setAgentName(call.agentName);
        setCallStatus(lifecycleToCallStatus(call.state));
      }
    } catch {}
  }, [connectToCall]);

  useEffect(() => {
    pollForActiveCalls();
    pollRef.current = setInterval(pollForActiveCalls, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (esRef.current) esRef.current.close();
    };
  }, [pollForActiveCalls]);

  useEffect(() => {
    if (callStatus === 'ended') {
      const timeout = setTimeout(() => {
        activeCallIdRef.current = null;
        setActiveCallId(null);
        setConnected(false);
        setCallStatus('idle');
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
      }, 30000);
      return () => clearTimeout(timeout);
    }
  }, [callStatus]);

  return {
    callStatus,
    activeCallId,
    agentName,
    duration,
    transcript,
    tools,
    activityEvents,
    connected,
  };
}
