import { Globe } from 'lucide-react';

interface Props {
  label?: string;
  description?: string;
}

export default function GlobalScopeBanner({
  label = 'Global / All Tenants',
  description = 'You are viewing platform-wide data aggregated across every tenant. No single-tenant context applies.',
}: Props) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-purple-500/30 bg-purple-500/10 px-4 py-3 text-purple-100">
      <Globe className="h-5 w-5 shrink-0 mt-0.5 text-purple-300" />
      <div className="text-sm">
        <p className="font-semibold uppercase tracking-wider text-xs text-purple-300">{label}</p>
        <p className="text-purple-100/80 mt-0.5">{description}</p>
      </div>
    </div>
  );
}
