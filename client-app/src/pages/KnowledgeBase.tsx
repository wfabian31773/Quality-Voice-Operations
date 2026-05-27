import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Pencil, Trash2, X, BookOpen, Search, Upload, Globe, FileText, HelpCircle, RefreshCw, Eye, File, ChevronDown, Check, Loader2 } from 'lucide-react';
import { EmptyState, Skeleton, SkeletonRows } from '../components/state';
import { PageHeader } from '../components/ui';
import TooltipWalkthrough from '../components/TooltipWalkthrough';
import { useRole } from '../lib/useRole';
import { renderMarkdownToSafeHtml } from '../lib/markdown';
import Modal from '../components/Modal';

interface Article {
  id: number;
  title: string;
  content: string;
  category: string | null;
  metadata: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
}

interface KnowledgeDocument {
  id: number;
  title: string;
  source_type: 'pdf' | 'url' | 'text' | 'faq';
  source_url: string | null;
  category: string | null;
  status: 'processing' | 'ready' | 'failed';
  error_message: string | null;
  file_name: string | null;
  file_size: number | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

interface DocumentChunk {
  id: number;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
}

interface ArticleFormData {
  title: string;
  content: string;
  category: string;
  status: string;
}

const CATEGORIES = ['FAQ', 'Services', 'Policies', 'Pricing', 'Procedures', 'Troubleshooting'];

const SOURCE_TYPE_LABELS: Record<string, { label: string; icon: typeof FileText; color: string }> = {
  pdf: { label: 'PDF', icon: File, color: 'bg-danger-light text-danger dark:bg-danger dark:text-danger' },
  url: { label: 'URL', icon: Globe, color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  text: { label: 'Text', icon: FileText, color: 'bg-info-light text-info dark:bg-info dark:text-info' },
  faq: { label: 'FAQ', icon: HelpCircle, color: 'bg-success-light text-success dark:bg-success dark:text-success' },
};

const STATUS_STYLES: Record<string, string> = {
  processing: 'bg-warning-light text-warning dark:bg-warning dark:text-warning',
  ready: 'bg-success-light text-success dark:bg-success dark:text-success',
  failed: 'bg-danger-light text-danger dark:bg-danger dark:text-danger',
  active: 'bg-success-light text-success dark:bg-success dark:text-success',
  draft: 'bg-warning-light text-warning dark:bg-warning dark:text-warning',
  archived: 'bg-surface-hover text-text-secondary',
};

const AUTOSAVE_DELAY_MS = 1500;

type AutosaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

function formatSavedAt(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const EMPTY_FORM: ArticleFormData = { title: '', content: '', category: '', status: 'active' };

function formsEqual(a: ArticleFormData, b: ArticleFormData): boolean {
  return a.title === b.title && a.content === b.content && a.category === b.category && a.status === b.status;
}

function ArticleModal({ articleId, onClose, onSaved }: { articleId?: number; onClose: () => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ArticleFormData>(EMPTY_FORM);
  const [loaded, setLoaded] = useState(!articleId);
  const [editorTab, setEditorTab] = useState<'edit' | 'preview'>('edit');
  const [currentArticleId, setCurrentArticleId] = useState<number | undefined>(articleId);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>('idle');
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  // Refs hold the freshest values so the autosave loop never captures stale data.
  const formRef = useRef<ArticleFormData>(EMPTY_FORM);
  const lastSavedFormRef = useRef<ArticleFormData | null>(null);
  const currentArticleIdRef = useRef<number | undefined>(articleId);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightPromiseRef = useRef<Promise<void> | null>(null);
  const closingRef = useRef(false);

  useEffect(() => { formRef.current = form; }, [form]);
  useEffect(() => { currentArticleIdRef.current = currentArticleId; }, [currentArticleId]);

  useEffect(() => {
    if (!articleId) return;
    api.get<{ article: Article }>(`/knowledge-articles/${articleId}`).then((res) => {
      const a = res.article;
      const next: ArticleFormData = {
        title: a.title ?? '',
        content: a.content ?? '',
        category: a.category ?? '',
        status: a.status ?? 'active',
      };
      setForm(next);
      formRef.current = next;
      lastSavedFormRef.current = next;
      setLastSavedAt(a.updated_at ? new Date(a.updated_at) : null);
      setLoaded(true);
    });
  }, [articleId]);

  const previewHtml = useMemo(() => renderMarkdownToSafeHtml(form.content), [form.content]);

  const performSave = (opts: { closeOnSuccess?: boolean } = {}): Promise<void> => {
    // If a save is already running, chain onto it. After it resolves, re-check
    // whether the form is still dirty and run another save with the latest
    // values. This guarantees no edits are lost while a request is in flight.
    if (inFlightPromiseRef.current) {
      const next = inFlightPromiseRef.current.then(() => {
        const latest = formRef.current;
        const last = lastSavedFormRef.current;
        const stillDirty = !last || !formsEqual(latest, last);
        const closeNow = opts.closeOnSuccess;
        if (!stillDirty) {
          if (closeNow && !closingRef.current) {
            closingRef.current = true;
            onSaved();
            onClose();
          }
          return;
        }
        return doSaveOnce(latest, opts);
      });
      return next;
    }
    return doSaveOnce(formRef.current, opts);
  };

  const doSaveOnce = (data: ArticleFormData, opts: { closeOnSuccess?: boolean }): Promise<void> => {
    if (!data.title.trim() || !data.content.trim()) {
      setAutosaveStatus('dirty');
      return Promise.resolve();
    }
    const id = currentArticleIdRef.current;
    setAutosaveStatus('saving');
    setAutosaveError(null);

    let runRef: Promise<void> | null = null;
    const run = (async () => {
      try {
        const payload = { ...data, category: data.category || null };
        let savedArticle: Article | null = null;
        if (id) {
          const res = await api.patch<{ article: Article }>(`/knowledge-articles/${id}`, payload);
          savedArticle = res?.article ?? null;
        } else {
          const res = await api.post<{ article: Article }>('/knowledge-articles', payload);
          savedArticle = res?.article ?? null;
          if (savedArticle?.id) {
            currentArticleIdRef.current = savedArticle.id;
            setCurrentArticleId(savedArticle.id);
          }
        }
        lastSavedFormRef.current = data;
        setLastSavedAt(new Date());
        queryClient.invalidateQueries({ queryKey: ['knowledge-articles'] });

        // After a successful save, check whether the user kept typing while
        // the request was in flight. If so, immediately schedule another save
        // with the latest data — that's how we avoid "lost updates".
        const latest = formRef.current;
        const stillDirty = !formsEqual(latest, data);
        if (stillDirty) {
          setAutosaveStatus('dirty');
        } else {
          setAutosaveStatus('saved');
          if (opts.closeOnSuccess && !closingRef.current) {
            closingRef.current = true;
            onSaved();
            onClose();
          }
        }
      } catch (err) {
        setAutosaveStatus('error');
        setAutosaveError((err as Error).message || 'Failed to save');
      } finally {
        if (inFlightPromiseRef.current === runRef) {
          inFlightPromiseRef.current = null;
        }
      }
    })();
    runRef = run;
    inFlightPromiseRef.current = run;

    // If the form is still dirty after this save resolves, fire the next one.
    return run.then(() => {
      const latest = formRef.current;
      const last = lastSavedFormRef.current;
      const stillDirty = !last || !formsEqual(latest, last);
      if (stillDirty && !closingRef.current) {
        return doSaveOnce(latest, opts);
      }
    });
  };

  useEffect(() => {
    if (!loaded || closingRef.current) return;
    const last = lastSavedFormRef.current;
    const baseline = last ?? EMPTY_FORM;
    const isDirty = !formsEqual(baseline, form);

    if (!isDirty) return;
    if (!form.title.trim() || !form.content.trim()) {
      setAutosaveStatus('dirty');
      return;
    }
    setAutosaveStatus('dirty');
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void performSave();
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [form, loaded]);

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  const set = (key: keyof ArticleFormData, val: string) => setForm((f) => ({ ...f, [key]: val }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    void performSave({ closeOnSuccess: true });
  };

  const renderAutosaveBadge = () => {
    if (autosaveStatus === 'saving') {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
          <Loader2 className="h-3 w-3 animate-spin" /> Saving...
        </span>
      );
    }
    if (autosaveStatus === 'saved' && lastSavedAt) {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
          <Check className="h-3 w-3 text-success dark:text-success" /> Saved at {formatSavedAt(lastSavedAt)}
        </span>
      );
    }
    if (autosaveStatus === 'dirty') {
      return <span className="text-xs text-text-secondary">Unsaved changes</span>;
    }
    if (autosaveStatus === 'error') {
      return <span className="text-xs text-danger">Autosave failed{autosaveError ? `: ${autosaveError}` : ''}</span>;
    }
    if (lastSavedAt) {
      return <span className="text-xs text-text-secondary">Last saved {formatSavedAt(lastSavedAt)}</span>;
    }
    return null;
  };

  if (!loaded) {
    return (
      <Modal open onClose={onClose} ariaLabel="Loading article" panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl p-6">
        <div className="space-y-3" role="status" aria-busy="true" aria-live="polite" aria-label="Loading article">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-32 w-full" rounded="lg" />
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} ariaLabel={currentArticleId ? 'Edit Article' : 'Create Article'} panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-text-primary">{currentArticleId ? 'Edit Article' : 'Create Article'}</h2>
            <div data-testid="autosave-status">{renderAutosaveBadge()}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Title</label>
            <input value={form.title} onChange={(e) => set('title', e.target.value)} required
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Category</label>
              <select value={form.category} onChange={(e) => set('category', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">No Category</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Status</label>
              <select value={form.status} onChange={(e) => set('status', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-text-primary">Content</label>
              <div className="inline-flex rounded-lg border border-border overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setEditorTab('edit')}
                  className={`px-3 py-1 transition ${editorTab === 'edit' ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:text-text-primary'}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setEditorTab('preview')}
                  className={`px-3 py-1 transition ${editorTab === 'preview' ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:text-text-primary'}`}
                >
                  Preview
                </button>
              </div>
            </div>
            {editorTab === 'edit' ? (
              <textarea value={form.content} onChange={(e) => set('content', e.target.value)} rows={12} required
                placeholder="Markdown is supported. Use **bold**, # headings, lists, etc."
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y" />
            ) : (
              <div
                data-testid="article-preview"
                className="prose prose-sm max-w-none min-h-[18rem] px-3 py-2 rounded-lg border border-border bg-surface-secondary text-text-primary"
                dangerouslySetInnerHTML={{ __html: previewHtml || '<p class="text-text-muted text-sm">Nothing to preview yet.</p>' }}
              />
            )}
            <p className="text-xs text-text-secondary mt-1">Markdown is rendered safely — scripts and unsafe HTML are stripped automatically.</p>
          </div>
          {autosaveStatus === 'error' && autosaveError && (
            <p className="text-danger text-sm">{autosaveError}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-hover transition">
              {autosaveStatus === 'saved' || autosaveStatus === 'idle' ? 'Close' : 'Cancel'}
            </button>
            <button type="submit" disabled={autosaveStatus === 'saving'}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
              {autosaveStatus === 'saving' ? 'Saving...' : currentArticleId ? 'Save & Close' : 'Create'}
            </button>
          </div>
        </form>
    </Modal>
  );
}

function UploadModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'pdf' | 'url' | 'text' | 'faq'>('pdf');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      if (tab === 'pdf') {
        if (!file) { setError('Please select a PDF file'); setSubmitting(false); return; }
        const formData = new FormData();
        formData.append('file', file);
        if (title) formData.append('title', title);
        if (category) formData.append('category', category);

        const token = localStorage.getItem('auth_token');
        const res = await fetch('/api/knowledge-documents/upload', {
          method: 'POST',
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          credentials: 'include',
          body: formData,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Upload failed: ${res.status}`);
        }
      } else if (tab === 'url') {
        if (!url) { setError('Please enter a URL'); setSubmitting(false); return; }
        await api.post('/knowledge-documents/url', { url, title: title || undefined, category: category || undefined });
      } else {
        if (!title) { setError('Please enter a title'); setSubmitting(false); return; }
        if (!content) { setError('Please enter content'); setSubmitting(false); return; }
        await api.post('/knowledge-documents/text', {
          title,
          content,
          category: category || undefined,
          source_type: tab,
        });
      }

      queryClient.invalidateQueries({ queryKey: ['knowledge-documents'] });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const tabs = [
    { id: 'pdf' as const, label: 'PDF Upload', icon: Upload },
    { id: 'url' as const, label: 'Website URL', icon: Globe },
    { id: 'text' as const, label: 'Text', icon: FileText },
    { id: 'faq' as const, label: 'FAQ', icon: HelpCircle },
  ];

  return (
    <Modal open onClose={onClose} ariaLabel="Add Knowledge Source" panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Add Knowledge Source</h2>
          <button onClick={onClose} aria-label="Close" className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition ${
                tab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {tab === 'pdf' && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">PDF File</label>
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition"
              >
                <Upload className="h-8 w-8 text-text-muted mx-auto mb-2" />
                {file ? (
                  <p className="text-sm text-text-primary">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
                ) : (
                  <p className="text-sm text-text-secondary">Click to select a PDF file (max 10MB)</p>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
            </div>
          )}

          {tab === 'url' && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Website URL</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/page"
                type="url"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="text-xs text-text-secondary mt-1">The page content will be automatically extracted and indexed.</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Title {tab === 'pdf' && <span className="text-text-secondary font-normal">(optional, defaults to filename)</span>}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required={tab === 'text' || tab === 'faq'}
              placeholder={tab === 'pdf' ? 'Leave blank to use filename' : 'Document title'}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              <option value="">No Category</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {(tab === 'text' || tab === 'faq') && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">
                {tab === 'faq' ? 'FAQ Content' : 'Text Content'}
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={10}
                required
                placeholder={tab === 'faq'
                  ? 'Q: What are your business hours?\nA: We are open Monday-Friday, 9am-5pm.\n\nQ: How do I reset my password?\nA: Click "Forgot Password" on the login page.'
                  : 'Paste your document text here...'}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
              />
            </div>
          )}

          {error && <p className="text-danger text-sm">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-hover transition">Cancel</button>
            <button type="submit" disabled={submitting}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
              {submitting ? 'Processing...' : 'Add Source'}
            </button>
          </div>
        </form>
    </Modal>
  );
}

function PreviewModal({ documentId, onClose }: { documentId: number; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['knowledge-document', documentId],
    queryFn: () => api.get<{ document: KnowledgeDocument; chunks: DocumentChunk[] }>(`/knowledge-documents/${documentId}`),
  });

  return (
    <Modal open onClose={onClose} ariaLabel="Document Preview" panelClassName="bg-surface border border-border rounded-xl shadow-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Document Preview</h2>
          <button onClick={onClose} aria-label="Close" className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>

        {isLoading ? (
          <div className="p-6 space-y-3">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : data ? (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-text-secondary">Title:</span>
                <span className="ml-2 text-text-primary font-medium">{data.document.title}</span>
              </div>
              <div>
                <span className="text-text-secondary">Type:</span>
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${SOURCE_TYPE_LABELS[data.document.source_type]?.color}`}>
                  {SOURCE_TYPE_LABELS[data.document.source_type]?.label}
                </span>
              </div>
              <div>
                <span className="text-text-secondary">Category:</span>
                <span className="ml-2 text-text-primary">{data.document.category || '-'}</span>
              </div>
              <div>
                <span className="text-text-secondary">Status:</span>
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[data.document.status]}`}>
                  {data.document.status}
                </span>
              </div>
              <div>
                <span className="text-text-secondary">Chunks:</span>
                <span className="ml-2 text-text-primary">{data.document.chunk_count}</span>
              </div>
              {data.document.source_url && (
                <div>
                  <span className="text-text-secondary">URL:</span>
                  <a href={data.document.source_url} target="_blank" rel="noopener noreferrer" className="ml-2 text-primary hover:underline text-xs break-all">
                    {data.document.source_url}
                  </a>
                </div>
              )}
            </div>

            {data.document.error_message && (
              <div className="bg-danger-light dark:bg-danger border border-danger dark:border-danger rounded-lg p-3 text-sm text-danger dark:text-danger">
                {data.document.error_message}
              </div>
            )}

            {data.chunks && data.chunks.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-text-primary mb-2">Content Chunks ({data.chunks.length})</h3>
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {data.chunks.map((chunk) => (
                    <div key={chunk.id} className="border border-border rounded-lg p-3">
                      <div className="text-xs text-text-secondary mb-1">Chunk {chunk.chunk_index + 1}</div>
                      <div className="text-sm text-text-primary whitespace-pre-wrap line-clamp-6">{chunk.content}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-8 text-center text-text-secondary">Document not found</div>
        )}
    </Modal>
  );
}

export default function KnowledgeBase() {
  const { t: tenantT } = useTranslation('tenant');
  const [activeView, setActiveView] = useState<'articles' | 'documents'>('documents');
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [previewDocId, setPreviewDocId] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const queryClient = useQueryClient();
  const { isManager } = useRole();

  const { data: articlesData, isLoading: articlesLoading } = useQuery({
    queryKey: ['knowledge-articles', categoryFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (categoryFilter) params.set('category', categoryFilter);
      return api.get<{ articles: Article[]; total: number; categories: string[] }>(`/knowledge-articles?${params}`);
    },
    enabled: activeView === 'articles',
  });

  const { data: documentsData, isLoading: documentsLoading } = useQuery({
    queryKey: ['knowledge-documents'],
    queryFn: () => api.get<{ documents: KnowledgeDocument[] }>('/knowledge-documents'),
    refetchInterval: 5000,
    enabled: activeView === 'documents',
  });

  const deleteArticleMut = useMutation({
    mutationFn: (id: number) => api.delete(`/knowledge-articles/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-articles'] }),
  });

  const deleteDocMut = useMutation({
    mutationFn: (id: number) => api.delete(`/knowledge-documents/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-documents'] }),
  });

  const reindexMut = useMutation({
    mutationFn: (id: number) => api.post(`/knowledge-documents/${id}/reindex`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-documents'] }),
  });

  const articles = articlesData?.articles ?? [];
  const categories = articlesData?.categories ?? [];
  const documents = documentsData?.documents ?? [];

  const filteredArticles = searchQuery
    ? articles.filter(
        (a) =>
          a.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          a.content.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : articles;

  const filteredDocuments = searchQuery
    ? documents.filter((d) => d.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : documents;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge"
        description="Manage knowledge sources for your AI agents"
        actions={isManager ? (
          <>
            <button onClick={() => setShowUpload(true)}
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-3 py-2 rounded-lg transition-colors">
              <Upload className="h-4 w-4" /> Add Source
            </button>
            {activeView === 'articles' && (
              <TooltipWalkthrough
                tooltipKey="knowledge-base-intro"
                title="Build Your Knowledge Base"
                description="Add articles and FAQs that your AI agent can reference during calls. This helps your agent provide accurate, context-aware responses to callers."
                position="left"
              >
                <button onClick={() => setEditingId('new')}
                  className="inline-flex items-center gap-2 bg-surface hover:bg-surface-hover text-text-primary text-sm font-medium px-3 py-2 rounded-lg border border-border transition-colors">
                  <Plus className="h-4 w-4" /> New Article
                </button>
              </TooltipWalkthrough>
            )}
          </>
        ) : undefined}
      />

      <div className="flex items-center gap-3 border-b border-border">
        <button
          onClick={() => setActiveView('documents')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
            activeView === 'documents'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          Documents ({documents.length})
        </button>
        <button
          onClick={() => setActiveView('articles')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
            activeView === 'articles'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          Articles ({articles.length})
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={activeView === 'documents' ? 'Search documents...' : 'Search articles...'}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        {activeView === 'articles' && (
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
          >
            <option value="">All Categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>

      {activeView === 'documents' ? (
        documentsLoading ? (
          <SkeletonRows count={5} rowClassName="h-14" />
        ) : filteredDocuments.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl">
            {documents.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No documents yet"
                description="Upload PDFs, paste URLs, or add text to build your knowledge base so your agents can answer questions accurately."
                primaryAction={isManager ? { label: 'Add Source', onClick: () => setShowUpload(true), icon: Upload } : undefined}
              />
            ) : (
              <EmptyState
                icon={Search}
                title="No documents match your search"
                description="Try a different keyword or clear your search to see all documents."
                primaryAction={{ label: 'Clear search', onClick: () => setSearchQuery('') }}
              />
            )}
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-5 py-3 font-medium text-text-secondary">Title</th>
                  <th className="text-left px-5 py-3 font-medium text-text-secondary hidden sm:table-cell">Type</th>
                  <th className="text-left px-5 py-3 font-medium text-text-secondary hidden sm:table-cell">Category</th>
                  <th className="text-left px-5 py-3 font-medium text-text-secondary hidden md:table-cell">Status</th>
                  <th className="text-left px-5 py-3 font-medium text-text-secondary hidden lg:table-cell">Chunks</th>
                  <th className="text-left px-5 py-3 font-medium text-text-secondary hidden lg:table-cell">Added</th>
                  <th className="px-5 py-3 w-32"></th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.map((doc) => {
                  const typeInfo = SOURCE_TYPE_LABELS[doc.source_type] || SOURCE_TYPE_LABELS.text;
                  const TypeIcon = typeInfo.icon;
                  return (
                    <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <TypeIcon className="h-4 w-4 text-text-muted flex-shrink-0" />
                          <div>
                            <div className="font-medium text-text-primary">{doc.title}</div>
                            {doc.file_name && doc.file_name !== doc.title && (
                              <div className="text-xs text-text-secondary mt-0.5">{doc.file_name}</div>
                            )}
                            {doc.source_url && (
                              <div className="text-xs text-text-secondary mt-0.5 truncate max-w-[250px]">{doc.source_url}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 hidden sm:table-cell">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${typeInfo.color}`}>
                          {typeInfo.label}
                        </span>
                      </td>
                      <td className="px-5 py-3 hidden sm:table-cell">
                        {doc.category ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-info-light text-info dark:bg-info dark:text-info">
                            {doc.category}
                          </span>
                        ) : (
                          <span className="text-text-muted text-xs">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 hidden md:table-cell">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[doc.status]}`}>
                          {doc.status}
                        </span>
                        {doc.status === 'processing' && (
                          <RefreshCw className="inline h-3 w-3 ml-1 text-warning dark:text-warning animate-spin" />
                        )}
                      </td>
                      <td className="px-5 py-3 text-text-secondary text-xs hidden lg:table-cell">
                        {doc.chunk_count || '-'}
                      </td>
                      <td className="px-5 py-3 text-text-secondary text-xs hidden lg:table-cell">
                        {new Date(doc.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          <button onClick={() => setPreviewDocId(doc.id)}
                            title="Preview"
                            className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition">
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          {isManager && (
                            <>
                              <button
                                onClick={() => reindexMut.mutate(doc.id)}
                                disabled={reindexMut.isPending || doc.status === 'processing'}
                                title="Re-index"
                                className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition disabled:opacity-50">
                                <RefreshCw className="h-3.5 w-3.5" />
                              </button>
                              <button onClick={() => { if (confirm(tenantT('common.confirms.delete_document'))) deleteDocMut.mutate(doc.id); }}
                                className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        articlesLoading ? (
          <SkeletonRows count={5} rowClassName="h-14" />
        ) : filteredArticles.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl">
            {articles.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No articles yet"
                description="Create your first knowledge base article so your agents can reference it on calls."
                primaryAction={isManager ? { label: 'New Article', onClick: () => setEditingId('new'), icon: Plus } : undefined}
              />
            ) : (
              <EmptyState
                icon={Search}
                title="No articles match your search"
                description="Try a different keyword or clear your search to see all articles."
                primaryAction={{ label: 'Clear search', onClick: () => setSearchQuery('') }}
              />
            )}
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-5 py-3 font-medium text-text-secondary">Title</th>
                  <th className="text-left px-5 py-3 font-medium text-text-secondary hidden sm:table-cell">Category</th>
                  <th className="text-left px-5 py-3 font-medium text-text-secondary hidden md:table-cell">Status</th>
                  <th className="text-left px-5 py-3 font-medium text-text-secondary hidden lg:table-cell">Updated</th>
                  <th className="px-5 py-3 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {filteredArticles.map((article) => (
                  <tr key={article.id} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium text-text-primary">{article.title}</div>
                      <div className="text-xs text-text-secondary mt-0.5 line-clamp-1">{article.content}</div>
                    </td>
                    <td className="px-5 py-3 hidden sm:table-cell">
                      {article.category ? (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-info-light text-info dark:bg-info dark:text-info">
                          {article.category}
                        </span>
                      ) : (
                        <span className="text-text-muted text-xs">-</span>
                      )}
                    </td>
                    <td className="px-5 py-3 hidden md:table-cell">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[article.status] || STATUS_STYLES.active}`}>
                        {article.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-secondary text-xs hidden lg:table-cell">
                      {new Date(article.updated_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      {isManager && (
                        <div className="flex items-center gap-2 justify-end">
                          <button onClick={() => setEditingId(article.id)}
                            className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => { if (confirm(tenantT('common.confirms.delete_article'))) deleteArticleMut.mutate(article.id); }}
                            className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {editingId !== null && (
        <ArticleModal
          articleId={editingId === 'new' ? undefined : editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {}}
        />
      )}

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}

      {previewDocId !== null && (
        <PreviewModal documentId={previewDocId} onClose={() => setPreviewDocId(null)} />
      )}
    </div>
  );
}
