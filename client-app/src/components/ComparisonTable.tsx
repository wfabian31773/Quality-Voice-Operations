import { Check, X, Minus } from 'lucide-react';

type Cell = boolean | 'partial' | string;

interface Row {
  label: string;
  qvo: Cell;
  retell: Cell;
  vapi: Cell;
  bland: Cell;
  traditional: Cell;
}

const rows: Row[] = [
  { label: 'Vertical templates (medical, legal, HVAC, dental)', qvo: true, retell: false, vapi: false, bland: false, traditional: false },
  { label: 'No-code agent builder', qvo: true, retell: 'partial', vapi: false, bland: 'partial', traditional: false },
  { label: 'Multi-channel (voice + SMS + web)', qvo: true, retell: false, vapi: false, bland: false, traditional: false },
  { label: 'Multi-tenant / multi-location', qvo: true, retell: false, vapi: false, bland: false, traditional: 'partial' },
  { label: 'HIPAA-ready with BAA', qvo: true, retell: false, vapi: false, bland: false, traditional: 'partial' },
  { label: 'Built-in scheduling & dispatch', qvo: true, retell: false, vapi: false, bland: false, traditional: true },
  { label: 'CRM + calendar integrations', qvo: true, retell: 'partial', vapi: 'partial', bland: 'partial', traditional: false },
  { label: 'Pricing model', qvo: 'Plan + per-minute', retell: 'Per-minute', vapi: 'Per-minute', bland: 'Per-minute', traditional: 'Per-call + retainer' },
  { label: 'Voice quality (sub-200ms latency)', qvo: true, retell: true, vapi: true, bland: 'partial', traditional: false },
  { label: '24/7 human support', qvo: true, retell: 'partial', vapi: 'partial', bland: 'partial', traditional: true },
];

function CellRender({ value }: { value: Cell }) {
  if (value === true) {
    return <Check className="h-4 w-4 text-calm-green mx-auto" aria-label="Yes" />;
  }
  if (value === false) {
    return <X className="h-4 w-4 text-soft-steel mx-auto" aria-label="No" />;
  }
  if (value === 'partial') {
    return <Minus className="h-4 w-4 text-warm-amber mx-auto" aria-label="Partial" />;
  }
  return <span className="text-xs font-medium text-harbor">{value}</span>;
}

const competitors = [
  { key: 'qvo', name: 'QVO', highlight: true },
  { key: 'retell', name: 'RetellAI', highlight: false },
  { key: 'vapi', name: 'Vapi', highlight: false },
  { key: 'bland', name: 'Bland', highlight: false },
  { key: 'traditional', name: 'Answering Service', highlight: false },
];

export default function ComparisonTable() {
  return (
    <div className="bg-white rounded-2xl border border-soft-steel/40 overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr className="border-b border-soft-steel/30 bg-mist/60">
              <th className="text-left py-4 px-6 font-display text-sm font-semibold text-harbor">Capability</th>
              {competitors.map((c) => (
                <th key={c.key} className={`text-center py-4 px-3 font-display text-sm font-semibold ${c.highlight ? 'text-teal bg-teal/5' : 'text-harbor'}`}>
                  {c.name}
                  {c.highlight && <span className="block text-[10px] text-teal font-medium mt-0.5">THIS PLATFORM</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.label} className={`hover:bg-teal/[0.03] transition-colors ${i % 2 === 0 ? 'bg-mist/20' : ''}`}>
                <td className="py-3.5 px-6 text-sm text-slate-ink/70 font-body">{row.label}</td>
                <td className="py-3.5 px-3 text-center bg-teal/[0.04]"><CellRender value={row.qvo} /></td>
                <td className="py-3.5 px-3 text-center"><CellRender value={row.retell} /></td>
                <td className="py-3.5 px-3 text-center"><CellRender value={row.vapi} /></td>
                <td className="py-3.5 px-3 text-center"><CellRender value={row.bland} /></td>
                <td className="py-3.5 px-3 text-center"><CellRender value={row.traditional} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bg-mist/40 border-t border-soft-steel/30 px-6 py-3 text-[11px] text-slate-ink/50 font-body">
        Based on publicly available product information as of {new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })}. Competitor capabilities change frequently — check their websites for the latest details.
      </div>
    </div>
  );
}
