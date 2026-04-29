import { useState, useEffect, useRef, useCallback } from 'react';
import type { TranscriptMessage } from '../components/demo/ConversationTranscript';
import type { ToolExecution } from '../components/demo/ToolExecutionPanel';
import type { ActivityEvent } from '../components/demo/SystemActivityFeed';
import type { CallStatus } from '../components/demo/CallStatusIndicator';

const API_BASE = '/api';

// Exponential backoff schedule (ms) used when the live SSE drops mid-call.
// Capped at 30s so a long outage doesn't spin forever.
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

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
  reconnecting: boolean;
}

export function lifecycleToCallStatus(state: string): CallStatus {
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
  const [reconnecting, setReconnecting] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callStatusRef = useRef<CallStatus>('idle');

  useEffect(() => {
    callStatusRef.current = callStatus;
  }, [callStatus]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connectToCall = useCallback(
    (callId: string, options: { reconnect?: boolean } = {}) => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      activeCallIdRef.current = callId;
      setActiveCallId(callId);

      // A fresh connection (not a reconnect) clears the buffered call data
      // and resets the backoff counter. Reconnects keep what we already have
      // so the prospect doesn't see the transcript blank out mid-call.
      if (!options.reconnect) {
        setTranscript([]);
        setTools([]);
        setActivityEvents([]);
        reconnectAttemptRef.current = 0;
        setReconnecting(false);
      }

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

      es.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        reconnectAttemptRef.current = 0;
        clearReconnectTimer();
      };
      es.onerror = () => {
        setConnected(false);

        // Don't try to reconnect for a stream that's no longer the active
        // call (e.g. the call ended and the drain timer already cleared it,
        // or a newer connectToCall() superseded this stream).
        if (activeCallIdRef.current !== callId) return;

        // The post-call drain window keeps the EventSource alive so trailing
        // events can land. If the server has already sent CALL_COMPLETED /
        // CALL_FAILED, don't dial back in — that would just loop.
        if (callStatusRef.current === 'ended') return;

        // If a reconnect is already pending, let it run rather than stacking
        // new timers on every flapping error event.
        if (reconnectTimerRef.current) return;

        // Tear down the dead socket so we don't leak it during the wait.
        if (esRef.current === es) {
          es.close();
          esRef.current = null;
        }

        const attempt = reconnectAttemptRef.current;
        const delay =
          RECONNECT_BACKOFF_MS[
            Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)
          ];
        setReconnecting(true);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          reconnectAttemptRef.current = attempt + 1;
          if (
            activeCallIdRef.current === callId &&
            callStatusRef.current !== 'ended'
          ) {
            connectToCall(callId, { reconnect: true });
          } else {
            setReconnecting(false);
          }
        }, delay);
      };
    },
    [clearReconnectTimer],
  );

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
      clearReconnectTimer();
    };
  }, [pollForActiveCalls, clearReconnectTimer]);

  useEffect(() => {
    if (callStatus === 'ended') {
      // A clean call end means we should stop attempting to reconnect; the
      // server will close the stream as part of its teardown.
      clearReconnectTimer();
      setReconnecting(false);
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
  }, [callStatus, clearReconnectTimer]);

  return {
    callStatus,
    activeCallId,
    agentName,
    duration,
    transcript,
    tools,
    activityEvents,
    connected,
    reconnecting,
  };
}
