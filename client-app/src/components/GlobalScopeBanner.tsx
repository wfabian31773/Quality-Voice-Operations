import { Globe, Eye } from 'lucide-react';

interface Props {
  label?: string;
  description?: string;
  variant?: 'global' | 'tenant';
  tenantName?: string;
  tenantSlug?: string;
}

export default function GlobalScopeBanner({
  label,
  description,
  variant = 'global',
  tenantName,
  tenantSlug,
}: Props) {
  if (variant === 'tenant') {
    const finalLabel = label ?? `Viewing as admin – tenant: ${tenantName ?? 'unknown'}`;
    const finalDescription =
      description
      ?? `You are inspecting another tenant's data as a platform admin. This is not your own tenant${tenantSlug ? ` (slug: ${tenantSlug})` : ''}.`;
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-100">
        <Eye className="h-5 w-5 shrink-0 mt-0.5 text-amber-300" />
        <div className="text-sm">
          <p className="font-semibold uppercase tracking-wider text-xs text-amber-300">{finalLabel}</p>
          <p className="text-amber-100/80 mt-0.5">{finalDescription}</p>
        </div>
      </div>
    );
  }

  const finalLabel = label ?? 'Global / All Tenants';
  const finalDescription =
    description
    ?? 'You are viewing platform-wide data aggregated across every tenant. No single-tenant context applies.';
  return (
    <div className="flex items-start gap-3 rounded-lg border border-purple-500/30 bg-purple-500/10 px-4 py-3 text-purple-100">
      <Globe className="h-5 w-5 shrink-0 mt-0.5 text-purple-300" />
      <div className="text-sm">
        <p className="font-semibold uppercase tracking-wider text-xs text-purple-300">{finalLabel}</p>
        <p className="text-purple-100/80 mt-0.5">{finalDescription}</p>
      </div>
    </div>
  );
}
