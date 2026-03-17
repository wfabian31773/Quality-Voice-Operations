import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Pencil, Trash2, X, BookOpen, Search } from 'lucide-react';
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

interface ArticleFormData {
  title: string;
  content: string;
  category: string;
  status: string;
}

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
              <input value={form.category} onChange={(e) => set('category', e.target.value)}
                placeholder="e.g. faq, policy, product"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
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

export default function KnowledgeBase() {
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['knowledge-articles', categoryFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (categoryFilter) params.set('category', categoryFilter);
      return api.get<{ articles: Article[]; total: number; categories: string[] }>(`/knowledge-articles?${params}`);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/knowledge-articles/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-articles'] }),
  });

  const articles = data?.articles ?? [];
  const categories = data?.categories ?? [];

  const filtered = searchQuery
    ? articles.filter(
        (a) =>
          a.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          a.content.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : articles;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Knowledge Base</h1>
          <p className="text-sm text-text-secondary mt-1">Manage articles and documentation for your AI agents</p>
        </div>
        <TooltipWalkthrough
          tooltipKey="knowledge-base-intro"
          title="Build Your Knowledge Base"
          description="Add articles and FAQs that your AI agent can reference during calls. This helps your agent provide accurate, context-aware responses to callers."
          position="left"
        >
          <button onClick={() => setEditingId('new')}
            className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
            <Plus className="h-4 w-4" /> New Article
          </button>
        </TooltipWalkthrough>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search articles..."
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
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
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : filtered.length === 0 ? (
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
              {filtered.map((article) => (
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
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      article.status === 'active'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : article.status === 'draft'
                        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                    }`}>
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
                      <button onClick={() => { if (confirm('Delete this article?')) deleteMut.mutate(article.id); }}
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
      )}

      {editingId !== null && (
        <ArticleModal
          articleId={editingId === 'new' ? undefined : editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {}}
        />
      )}
    </div>
  );
}
