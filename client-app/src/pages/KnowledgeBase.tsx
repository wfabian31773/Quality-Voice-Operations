import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Pencil, Trash2, X, BookOpen, Search, Upload, Globe, FileText, HelpCircle, RefreshCw, Eye, File, ChevronDown } from 'lucide-react';
import TooltipWalkthrough from '../components/TooltipWalkthrough';

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
  pdf: { label: 'PDF', icon: File, color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  url: { label: 'URL', icon: Globe, color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  text: { label: 'Text', icon: FileText, color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  faq: { label: 'FAQ', icon: HelpCircle, color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
};

const STATUS_STYLES: Record<string, string> = {
  processing: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  ready: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  draft: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  archived: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

function ArticleModal({ articleId, onClose, onSaved }: { articleId?: number; onClose: () => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ArticleFormData>({
    title: '',
    content: '',
    category: '',
    status: 'active',
  });
  const [loaded, setLoaded] = useState(!articleId);

  useEffect(() => {
    if (!articleId) return;
    api.get<{ article: Article }>(`/knowledge-articles/${articleId}`).then((res) => {
      const a = res.article;
      setForm({
        title: a.title ?? '',
        content: a.content ?? '',
        category: a.category ?? '',
        status: a.status ?? 'active',
      });
      setLoaded(true);
    });
  }, [articleId]);

  const mutation = useMutation({
    mutationFn: (data: ArticleFormData) => {
      const payload = { ...data, category: data.category || null };
      return articleId
        ? api.patch(`/knowledge-articles/${articleId}`, payload)
        : api.post('/knowledge-articles', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-articles'] });
      onSaved();
      onClose();
    },
  });

  const set = (key: keyof ArticleFormData, val: string) => setForm((f) => ({ ...f, [key]: val }));

  if (!loaded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
        <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl p-8 text-center text-text-secondary">
          Loading article...
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">{articleId ? 'Edit Article' : 'Create Article'}</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); mutation.mutate(form); }}
          className="p-5 space-y-4"
        >
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
            <label className="block text-sm font-medium text-text-primary mb-1">Content</label>
            <textarea value={form.content} onChange={(e) => set('content', e.target.value)} rows={12} required
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y" />
          </div>
          {mutation.error && <p className="text-danger text-sm">{(mutation.error as Error).message}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-hover transition">Cancel</button>
            <button type="submit" disabled={mutation.isPending}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
              {mutation.isPending ? 'Saving...' : articleId ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Add Knowledge Source</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
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
      </div>
    </div>
  );
}

function PreviewModal({ documentId, onClose }: { documentId: number; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['knowledge-document', documentId],
    queryFn: () => api.get<{ document: KnowledgeDocument; chunks: DocumentChunk[] }>(`/knowledge-documents/${documentId}`),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Document Preview</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-text-secondary">Loading...</div>
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
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-400">
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
      </div>
    </div>
  );
}

export default function KnowledgeBase() {
  const [activeView, setActiveView] = useState<'articles' | 'documents'>('documents');
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [previewDocId, setPreviewDocId] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const queryClient = useQueryClient();

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Knowledge Base</h1>
          <p className="text-sm text-text-secondary mt-1">Manage knowledge sources for your AI agents</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
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
                className="inline-flex items-center gap-2 bg-surface hover:bg-surface-hover text-text-primary text-sm font-medium px-4 py-2.5 rounded-lg border border-border transition">
                <Plus className="h-4 w-4" /> New Article
              </button>
            </TooltipWalkthrough>
          )}
        </div>
      </div>

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
          <div className="text-center py-12 text-text-secondary">Loading...</div>
        ) : filteredDocuments.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl p-12 text-center">
            <BookOpen className="h-12 w-12 text-text-muted mx-auto mb-3" />
            <p className="text-text-secondary">
              {documents.length === 0
                ? 'No documents yet. Upload PDFs, paste URLs, or add text to build your knowledge base.'
                : 'No documents match your search.'}
            </p>
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
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
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
                          <RefreshCw className="inline h-3 w-3 ml-1 text-yellow-500 animate-spin" />
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
                          <button
                            onClick={() => reindexMut.mutate(doc.id)}
                            disabled={reindexMut.isPending || doc.status === 'processing'}
                            title="Re-index"
                            className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition disabled:opacity-50">
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => { if (confirm('Delete this document and all its chunks?')) deleteDocMut.mutate(doc.id); }}
                            className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
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
          <div className="text-center py-12 text-text-secondary">Loading...</div>
        ) : filteredArticles.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl p-12 text-center">
            <BookOpen className="h-12 w-12 text-text-muted mx-auto mb-3" />
            <p className="text-text-secondary">
              {articles.length === 0
                ? 'No articles yet. Create your first knowledge base article to get started.'
                : 'No articles match your search.'}
            </p>
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
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
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
                      <div className="flex items-center gap-2 justify-end">
                        <button onClick={() => setEditingId(article.id)}
                          className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => { if (confirm('Delete this article?')) deleteArticleMut.mutate(article.id); }}
                          className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
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
