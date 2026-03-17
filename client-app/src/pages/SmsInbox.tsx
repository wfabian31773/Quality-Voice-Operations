import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MessageSquare, Send, Sparkles, Phone, ArrowLeft, Inbox } from 'lucide-react';

interface Conversation {
  phoneNumberId: string;
  phoneNumber: string;
  friendlyName: string;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  body: string;
  timestamp: string;
  status: string;
}

interface Thread {
  remoteNumber: string;
  messages: Message[];
  lastMessage: Message;
  messageCount: number;
}

export default function SmsInbox() {
  const { user } = useAuth();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [replyText, setReplyText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ conversations: Conversation[] }>('/sms-inbox/conversations')
      .then((data) => setConversations(data.conversations))
      .catch(() => setError('Failed to load conversations'))
      .finally(() => setLoading(false));
  }, []);

  const selectConversation = async (conv: Conversation) => {
    setSelectedConv(conv);
    setSelectedThread(null);
    setThreads([]);
    try {
      const data = await api.get<{ threads: Thread[] }>(`/sms-inbox/conversations/${conv.phoneNumberId}/messages`);
      setThreads(data.threads || []);
    } catch {
      setError('Failed to load messages');
    }
  };

  const selectThread = (thread: Thread) => {
    setSelectedThread(thread);
  };

  const sendReply = async () => {
    if (!replyText.trim() || !selectedConv || !selectedThread || isReadOnly) return;
    setSending(true);
    try {
      const data = await api.post<{ message: Message }>(`/sms-inbox/conversations/${selectedConv.phoneNumberId}/send`, {
        to: selectedThread.remoteNumber,
        body: replyText,
      });
      setSelectedThread(prev => prev ? {
        ...prev,
        messages: [...prev.messages, data.message],
        lastMessage: data.message,
        messageCount: prev.messageCount + 1,
      } : prev);
      setReplyText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const generateDraft = async () => {
    if (!selectedThread) return;
    setDrafting(true);
    try {
      const context = selectedThread.messages.slice(-5).map(m => `${m.direction === 'inbound' ? 'Customer' : 'Us'}: ${m.body}`).join('\n');
      const data = await api.post<{ draft: string }>('/sms-inbox/ai-draft', { context });
      setReplyText(data.draft);
    } catch {
      setError('Failed to generate draft');
    } finally {
      setDrafting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const showThreadList = selectedConv && !selectedThread;
  const showMessages = selectedConv && selectedThread;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <MessageSquare className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-heading">SMS Inbox</h1>
          <p className="text-sm text-muted mt-0.5">View and reply to SMS conversations</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="flex gap-4 h-[calc(100vh-220px)] min-h-[400px]">
        <div className={`${selectedConv ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-72 shrink-0 bg-surface border border-border rounded-xl overflow-hidden`}>
          <div className="p-4 border-b border-border">
            <h2 className="font-semibold text-heading text-sm">Phone Lines</h2>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="p-8 text-center text-muted text-sm">
                <Phone className="h-8 w-8 mx-auto mb-2 opacity-40" />
                <p>No phone numbers configured</p>
              </div>
            ) : (
              conversations.map((conv) => (
                <button
                  key={conv.phoneNumberId}
                  onClick={() => selectConversation(conv)}
                  className={`w-full text-left px-4 py-3 border-b border-border hover:bg-surface-secondary transition-colors ${
                    selectedConv?.phoneNumberId === conv.phoneNumberId ? 'bg-primary/10' : ''
                  }`}
                >
                  <div className="font-medium text-sm text-heading">{conv.friendlyName || conv.phoneNumber}</div>
                  <div className="text-xs text-muted mt-0.5">{conv.phoneNumber}</div>
                </button>
              ))
            )}
          </div>
        </div>

        {showThreadList && (
          <div className={`${selectedConv ? 'flex' : 'hidden md:flex'} flex-col flex-1 bg-surface border border-border rounded-xl overflow-hidden`}>
            <div className="flex items-center gap-3 p-4 border-b border-border">
              <button onClick={() => setSelectedConv(null)} className="md:hidden text-muted hover:text-heading">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <h3 className="font-semibold text-heading text-sm">
                  Threads for {selectedConv.friendlyName || selectedConv.phoneNumber}
                </h3>
                <p className="text-xs text-muted">{threads.length} conversation{threads.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {threads.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-muted text-sm p-8">
                  <div className="text-center">
                    <Inbox className="h-10 w-10 mx-auto mb-3 opacity-40" />
                    <p>No SMS threads found for this number</p>
                  </div>
                </div>
              ) : (
                threads.map((thread) => (
                  <button
                    key={thread.remoteNumber}
                    onClick={() => selectThread(thread)}
                    className="w-full text-left px-4 py-3 border-b border-border hover:bg-surface-secondary transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm text-heading">{thread.remoteNumber}</div>
                      <span className="text-[10px] text-muted bg-surface-secondary rounded-full px-2 py-0.5">
                        {thread.messageCount}
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-1 truncate">{thread.lastMessage.body}</p>
                    <p className="text-[10px] text-muted mt-0.5">
                      {new Date(thread.lastMessage.timestamp).toLocaleString()}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {showMessages && (
          <div className="flex flex-col flex-1 bg-surface border border-border rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 p-4 border-b border-border">
              <button onClick={() => setSelectedThread(null)} className="text-muted hover:text-heading">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <h3 className="font-semibold text-heading text-sm">{selectedThread.remoteNumber}</h3>
                <p className="text-xs text-muted">{selectedThread.messageCount} messages</p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {selectedThread.messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] rounded-xl px-4 py-2.5 text-sm ${
                    msg.direction === 'outbound'
                      ? 'bg-primary text-white'
                      : 'bg-surface-secondary text-heading'
                  }`}>
                    <p>{msg.body}</p>
                    <div className={`text-[10px] mt-1 ${msg.direction === 'outbound' ? 'text-white/70' : 'text-muted'}`}>
                      {new Date(msg.timestamp).toLocaleTimeString()} &middot; {msg.status}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {!isReadOnly && (
              <div className="p-4 border-t border-border">
                <div className="flex gap-2">
                  <button
                    onClick={generateDraft}
                    disabled={drafting}
                    className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium bg-surface-secondary text-heading hover:bg-primary/10 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Sparkles className="h-4 w-4" />
                    {drafting ? 'Drafting...' : 'AI Draft'}
                  </button>
                  <input
                    type="text"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendReply()}
                    placeholder="Type your reply..."
                    className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    onClick={sendReply}
                    disabled={sending || !replyText.trim()}
                    className="shrink-0 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Send className="h-4 w-4" />
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {!selectedConv && (
          <div className="hidden md:flex flex-col flex-1 bg-surface border border-border rounded-xl overflow-hidden items-center justify-center text-muted text-sm">
            <div className="text-center">
              <Inbox className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p>Select a phone line to view messages</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
