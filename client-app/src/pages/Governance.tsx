import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cpu, Filter, Globe } from 'lucide-react';
import clsx from 'clsx';
import EvolutionEngine from './EvolutionEngine';
import ConversionFunnel from './ConversionFunnel';
import GlobalIntelligence from './GlobalIntelligence';

type GovernanceTab = 'evolution' | 'funnel' | 'intelligence';

const TABS: { key: GovernanceTab; label: string; icon: typeof Cpu }[] = [
  { key: 'evolution', label: 'Evolution Engine', icon: Cpu },
  { key: 'funnel', label: 'Conversion Funnel', icon: Filter },
  { key: 'intelligence', label: 'Global Intelligence', icon: Globe },
];

export default function Governance() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const activeTab = useMemo<GovernanceTab>(() => {
    if (requested === 'evolution' || requested === 'funnel' || requested === 'intelligence') {
      return requested;
    }
    return 'evolution';
  }, [requested]);

  const setTab = (key: GovernanceTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors',
              activeTab === tab.key
                ? 'bg-primary text-white'
                : 'text-muted hover:text-foreground hover:bg-surface-secondary',
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'evolution' && <EvolutionEngine />}
      {activeTab === 'funnel' && <ConversionFunnel />}
      {activeTab === 'intelligence' && <GlobalIntelligence />}
    </div>
  );
}
