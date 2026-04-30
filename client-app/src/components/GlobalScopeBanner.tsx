import { Globe, Eye } from 'lucide-react';

interface Props {
  label?: string;
  description?: string;
  variant?: 'global' | 'tenant';
  tenantName?: string;
  tenantSlug?: string;
  compact?: boolean;
}

export default function GlobalScopeBanner({
  label,
  description,
  variant = 'global',
  tenantName,
  tenantSlug,
  compact = false,
}: Props) {
  const padding = compact ? 'px-3 py-2' : 'px-4 py-3';

  if (variant === 'tenant') {
    const finalLabel = label ?? `Viewing as admin — tenant: ${tenantName ?? 'unknown'}`;
    const finalDescription =
      description
      ?? `You are inspecting another tenant's data as a platform admin. This is not your own tenant${tenantSlug ? ` (slug: ${tenantSlug})` : ''}.`;
    return (
      <div
        role="status"
        aria-live="polite"
        className={`flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-light text-text-primary ${padding}`}
      >
        <Eye className="h-5 w-5 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
        <div className="text-sm min-w-0">
          <p className="font-semibold uppercase tracking-wider text-xs text-warning">{finalLabel}</p>
          {!compact && (
            <p className="text-text-secondary mt-0.5">{finalDescription}</p>
          )}
        </div>
      </div>
    );
  }

  const finalLabel = label ?? 'Global / All Tenants';
  const finalDescription =
    description
    ?? 'You are viewing platform-wide data aggregated across every tenant. No single-tenant context applies.';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 rounded-lg border border-info/30 bg-info-light text-text-primary ${padding}`}
    >
      <Globe className="h-5 w-5 shrink-0 mt-0.5 text-info" aria-hidden="true" />
      <div className="text-sm min-w-0">
        <p className="font-semibold uppercase tracking-wider text-xs text-info">{finalLabel}</p>
        {!compact && (
          <p className="text-text-secondary mt-0.5">{finalDescription}</p>
        )}
      </div>
    </div>
  );
}
