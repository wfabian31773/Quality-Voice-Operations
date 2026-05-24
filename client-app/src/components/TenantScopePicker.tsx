import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Globe, Search, Check, Building2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';

interface TenantSummaryLite {
  id: string;
  name: string;
  slug: string;
  status?: string;
}

const TENANT_PATH_RE = /^\/admin\/analytics\/tenants\/([^/]+)(.*)$/;

function parseScope(pathname: string): { tenantId: string | null; subpath: string } {
  const m = TENANT_PATH_RE.exec(pathname);
  if (!m) return { tenantId: null, subpath: '' };
  return { tenantId: m[1], subpath: m[2] ?? '' };
}

export default function TenantScopePicker() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { tenantId: activeTenantId, subpath } = parseScope(location.pathname);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['scope-picker-tenants'],
    queryFn: () =>
      api.get<{ tenants: TenantSummaryLite[] }>('/platform/tenants'),
    staleTime: 60_000,
  });
  const tenants = data?.tenants ?? [];

  const activeTenant = useMemo(
    () => tenants.find((tn) => tn.id === activeTenantId) ?? null,
    [tenants, activeTenantId],
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setQuery('');
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter(
      (tn) => tn.name.toLowerCase().includes(q) || tn.slug.toLowerCase().includes(q),
    );
  }, [tenants, query]);

  const goTo = (tenantId: string | null) => {
    setOpen(false);
    if (tenantId === null) {
      if (activeTenantId) navigate('/admin/analytics');
      return;
    }
    if (activeTenantId) {
      navigate(`/admin/analytics/tenants/${tenantId}${subpath}`);
    } else {
      navigate(`/admin/analytics/tenants/${tenantId}`);
    }
  };

  const buttonLabel = activeTenant?.name ?? (activeTenantId ?? t('tenant_scope_picker.global_short'));
  const buttonSub = activeTenant?.slug ?? t('tenant_scope_picker.all_tenants');
  const dotTone = activeTenantId ? 'bg-warning' : 'bg-info';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('tenant_scope_picker.tooltip', { label: buttonLabel, sub: buttonSub })}
        className={clsx(
          'inline-flex items-center gap-2 rounded-md border border-border bg-surface text-text-primary',
          'hover:bg-surface-hover transition-colors text-xs font-medium px-2.5 py-1.5',
        )}
      >
        <span className={clsx('h-1.5 w-1.5 rounded-full shrink-0', dotTone)} aria-hidden="true" />
        {activeTenantId ? (
          <Building2 className="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
        ) : (
          <Globe className="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
        )}
        <span className="hidden sm:inline max-w-[160px] truncate">{buttonLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('tenant_scope_picker.scope_aria')}
          className="absolute z-dropdown mt-2 w-72 right-0 sm:right-auto sm:left-0 rounded-lg border border-border bg-surface shadow-[var(--elevation-2)] overflow-hidden"
        >
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('tenant_scope_picker.search_placeholder')}
                className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-border bg-surface-secondary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>

          <ul className="max-h-72 overflow-y-auto py-1">
            <li>
              <button
                type="button"
                onClick={() => goTo(null)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors',
                  !activeTenantId
                    ? 'bg-info-light text-info'
                    : 'text-text-primary hover:bg-surface-hover',
                )}
              >
                <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium">{t('tenant_scope_picker.global_label')}</span>
                  <span className="block text-[10px] text-text-muted">{t('tenant_scope_picker.global_subtitle')}</span>
                </span>
                {!activeTenantId && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              </button>
            </li>

            {isLoading && (
              <li className="px-3 py-2 text-[11px] text-text-muted">{t('tenant_scope_picker.loading')}</li>
            )}

            {!isLoading && filtered.length === 0 && (
              <li className="px-3 py-2 text-[11px] text-text-muted">{t('tenant_scope_picker.no_match')}</li>
            )}

            {filtered.map((tn) => {
              const active = tn.id === activeTenantId;
              return (
                <li key={tn.id}>
                  <button
                    type="button"
                    onClick={() => goTo(tn.id)}
                    className={clsx(
                      'w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors',
                      active
                        ? 'bg-warning-light text-warning'
                        : 'text-text-primary hover:bg-surface-hover',
                    )}
                  >
                    <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium truncate">{tn.name}</span>
                      <span className="block text-[10px] text-text-muted truncate">
                        {tn.slug}
                        {tn.status && tn.status !== 'active' ? ` · ${tn.status}` : ''}
                      </span>
                    </span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
