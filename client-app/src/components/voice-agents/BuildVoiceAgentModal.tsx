import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Headphones, TrendingUp, Calendar, Briefcase, UserPlus, Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import {
  VOICE_AGENT_TEMPLATE_CHIPS,
  type VoiceAgentTemplateChipId,
} from '../../lib/voiceAgentTemplates';

export interface AssistDraftPayload {
  name: string;
  type: 'general';
  templateId: VoiceAgentTemplateChipId | 'blank';
  businessName: string;
  website: string;
  systemPrompt: string;
  welcomeGreeting: string;
  tools: string[];
  language: string;
  voice: string;
  model: string;
}

interface AssistResponse {
  messages: { role: 'assistant' | 'user'; content: string }[];
  draft: AssistDraftPayload;
  done: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (agentId: string) => void;
}

const TEMPLATE_ICONS: Record<VoiceAgentTemplateChipId, typeof Headphones> = {
  customer_support: Headphones,
  sales_associate: TrendingUp,
  appointment_scheduler: Calendar,
  personal_assistant: Briefcase,
  lead_qualification: UserPlus,
};

const TEMPLATE_TONES: Record<VoiceAgentTemplateChipId, string> = {
  customer_support: 'bg-warning-light text-warning',
  sales_associate: 'bg-success-light text-success',
  appointment_scheduler: 'bg-primary-light text-primary',
  personal_assistant: 'bg-surface-secondary text-text-secondary',
  lead_qualification: 'bg-primary-light text-primary',
};

export default function BuildVoiceAgentModal({ open, onClose, onCreated }: Props) {
  const [messages, setMessages] = useState<{ role: 'assistant' | 'user'; content: string }[]>([]);
  const [draft, setDraft] = useState<AssistDraftPayload | null>(null);
  const [templateId, setTemplateId] = useState<VoiceAgentTemplateChipId | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMessages([]);
    setDraft(null);
    setTemplateId(null);
    setInput('');
    setError(null);
    setBusy(true);
    api.post<AssistResponse>('/agents/assist', { messages: [] })
      .then((result) => {
        setMessages(result.messages);
        setDraft(result.draft);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Unable to start the builder.');
      })
      .finally(() => setBusy(false));
  }, [open]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const templates = useMemo(() => VOICE_AGENT_TEMPLATE_CHIPS, []);

  if (!open) return null;

  async function send(next: { text?: string; templateId?: VoiceAgentTemplateChipId; skip?: boolean }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const nextMessages = next.text
      ? [...messages, { role: 'user' as const, content: next.text }]
      : messages;
    try {
      const result = await api.post<AssistResponse>('/agents/assist', {
        messages: nextMessages,
        templateId: next.templateId ?? templateId,
        skip: next.skip === true,
      });
      setMessages(result.messages);
      setDraft(result.draft);
      if (next.templateId) setTemplateId(next.templateId);
      setInput('');
      if (result.done) {
        const created = await api.post<{ agent: { id: string } }>('/agents', {
          name: result.draft.name,
          type: 'general',
          system_prompt: result.draft.systemPrompt,
          welcome_greeting: result.draft.welcomeGreeting,
          voice: result.draft.voice,
          model: result.draft.model,
          language: result.draft.language,
          tools: result.draft.tools.map((name) => ({ name })),
          metadata: {
            templateId: result.draft.templateId,
            businessName: result.draft.businessName,
            website: result.draft.website,
            enabledLibraryTools: result.draft.tools,
            rolePackageId: 'core-receptionist',
          },
        });
        onCreated(created.agent.id);
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to continue.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate/40">
      <div
        role="dialog"
        aria-labelledby="build-voice-agent-title"
        className="flex w-full max-w-2xl max-h-[min(720px,90dvh)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 id="build-voice-agent-title" className="text-base font-semibold text-text-primary">
            Build a voice agent
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void send({ skip: true })}
              disabled={busy}
              className="px-3 py-1.5 rounded-full text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-full text-text-muted hover:bg-surface-hover"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div ref={scroller} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <p
                className={
                  message.role === 'user'
                    ? 'max-w-[80%] rounded-2xl bg-harbor-800 text-on-primary px-4 py-2.5 text-sm'
                    : 'max-w-[90%] text-sm text-text-primary leading-relaxed'
                }
              >
                {message.content}
              </p>
            </div>
          ))}

          {messages.length <= 1 && (
            <div className="flex flex-wrap gap-2">
              {templates.map((template) => {
                const Icon = TEMPLATE_ICONS[template.id];
                return (
                  <button
                    key={template.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void send({ templateId: template.id })}
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover disabled:opacity-50"
                  >
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full ${TEMPLATE_TONES[template.id]}`}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    {template.name}
                  </button>
                );
              })}
            </div>
          )}

          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>

        <form
          className="border-t border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const text = input.trim();
            if (!text) return;
            void send({ text });
          }}
        >
          <div className="flex items-center gap-2 rounded-full border border-border bg-surface-secondary px-3 py-1.5">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Describe your agent's use case..."
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || input.trim().length === 0}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-40"
              aria-label="Send"
            >
              {draft ? <ArrowUp className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
