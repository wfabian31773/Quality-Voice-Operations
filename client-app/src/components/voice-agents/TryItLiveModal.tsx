import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, PhoneOff, X } from 'lucide-react';
import { api } from '../../lib/api';
import {
  PCMU_SAMPLE_RATE,
  base64ToBytes,
  bytesToBase64,
  decodePcmuToPcm16,
  downsamplePcm16,
  encodePcmuFromPcm16,
} from '../../../../platform/agent-runtime/pcmuCodec';

type LiveState = 'idle' | 'requesting' | 'connecting' | 'live' | 'error';

function playPcmu(base64: string, ctx: AudioContext, nextTime: { current: number }): void {
  const pcm16 = decodePcmuToPcm16(base64ToBytes(base64));
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) {
    float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
  }
  const buffer = ctx.createBuffer(1, float32.length, PCMU_SAMPLE_RATE);
  buffer.getChannelData(0).set(float32);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const startTime = Math.max(ctx.currentTime, nextTime.current);
  source.start(startTime);
  nextTime.current = startTime + buffer.duration;
}

export default function TryItLiveModal({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<LiveState>('requesting');
  const [message, setMessage] = useState('Asking the voice gateway for a preview session…');
  const socketRef = useRef<WebSocket | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackNextRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const preview = await api.post<{ streamPath: string }>(`/agents/${agentId}/live-preview`, {});
        if (cancelled) return;
        setState('connecting');
        setMessage('Connecting to the Master Voice Agent…');

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const socket = new WebSocket(`${proto}://${window.location.host}${preview.streamPath}`);
        socketRef.current = socket;

        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'start' }));
        };
        socket.onmessage = (event) => {
          try {
            const payload = JSON.parse(String(event.data)) as { type?: string; data?: string; message?: string };
            if (payload.type === 'ready') {
              setState('live');
              setMessage('Listening. Speak to try this agent.');
              void startMic(socket);
            } else if (payload.type === 'audio' && payload.data) {
              if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
                playbackCtxRef.current = new AudioContext({ sampleRate: PCMU_SAMPLE_RATE });
                playbackNextRef.current = 0;
              }
              playPcmu(payload.data, playbackCtxRef.current, playbackNextRef);
            } else if (payload.type === 'error') {
              setState('error');
              setMessage(payload.message || 'The live preview could not start.');
            }
          } catch {
            // ignore malformed frames
          }
        };
        socket.onerror = () => {
          setState('error');
          setMessage('The preview socket failed. Check that the voice gateway is running.');
        };
        socket.onclose = () => {
          if (!cancelled) setMessage((current) => (current.includes('failed') || current.includes('required') ? current : 'Preview ended.'));
        };
      } catch (err) {
        if (cancelled) return;
        setState('error');
        setMessage(err instanceof Error ? err.message : 'Could not start a live preview.');
      }
    }

    void start();
    return () => {
      cancelled = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only session
  }, [agentId]);

  async function startMic(socket: WebSocket) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRef.current = stream;
      const audioContext = new AudioContext({ sampleRate: 24000 });
      captureCtxRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioContext.destination);
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const float32 = event.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i += 1) {
          const sample = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        const pcmu = encodePcmuFromPcm16(
          downsamplePcm16(int16, audioContext.sampleRate || 24000, PCMU_SAMPLE_RATE),
        );
        socket.send(JSON.stringify({ type: 'audio', data: bytesToBase64(pcmu) }));
      };
    } catch {
      setState('error');
      setMessage('Microphone access is required to try the agent live.');
    }
  }

  function teardown() {
    const socket = socketRef.current;
    if (socket) {
      try { socket.send(JSON.stringify({ type: 'stop' })); } catch { /* already closed */ }
      socket.close();
      socketRef.current = null;
    }
    mediaRef.current?.getTracks().forEach((track) => track.stop());
    mediaRef.current = null;
    void captureCtxRef.current?.close();
    void playbackCtxRef.current?.close();
    captureCtxRef.current = null;
    playbackCtxRef.current = null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-labelledby="try-it-live-title" className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="try-it-live-title" className="text-lg font-semibold text-text-primary">Try it live</h2>
            <p className="mt-1 text-sm text-text-muted">
              This talks to the same Master Voice Agent runtime as a phone call. The browser never holds the xAI key.
            </p>
          </div>
          <button type="button" onClick={() => { teardown(); onClose(); }} className="rounded-full p-1 text-text-muted hover:bg-surface-hover" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface-secondary px-4 py-8 text-center">
          <span className={`flex h-16 w-16 items-center justify-center rounded-full ${state === 'live' ? 'bg-primary text-on-primary' : 'bg-surface text-text-muted'}`}>
            {state === 'requesting' || state === 'connecting'
              ? <Loader2 className="h-7 w-7 animate-spin" />
              : <Mic className="h-7 w-7" />}
          </span>
          <p className="text-sm text-text-secondary">{message}</p>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => { teardown(); onClose(); }}
            className="inline-flex items-center gap-2 rounded-full bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover"
          >
            <PhoneOff className="h-4 w-4" />
            End preview
          </button>
        </div>
      </div>
    </div>
  );
}
