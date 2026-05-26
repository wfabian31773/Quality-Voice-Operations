import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Cpu, Filter, Globe } from 'lucide-react';
import clsx from 'clsx';
import EvolutionEngine from './EvolutionEngine';
import ConversionFunnel from './ConversionFunnel';
import GlobalIntelligence from './GlobalIntelligence';

type GovernanceTab = 'evolution' | 'funnel' | 'intelligence';

const TAB_DEFS: { key: GovernanceTab; labelKey: string; icon: typeof Cpu }[] = [
  { key: 'evolution', labelKey: 'governance.evolution_engine', icon: Cpu },
  { key: 'funnel', labelKey: 'governance.conversion_funnel', icon: Filter },
  { key: 'intelligence', labelKey: 'governance.global_intelligence', icon: Globe },
];

export default function Governance() {
  const { t } = useTranslation('tenant');
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
        {TAB_DEFS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors',
              activeTab === tab.key
                ? 'bg-primary text-white'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-secondary',
            )}
          >
            <tab.icon className="h-4 w-4" />
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {activeTab === 'evolution' && <EvolutionEngine />}
      {activeTab === 'funnel' && <ConversionFunnel />}
      {activeTab === 'intelligence' && <GlobalIntelligence />}
    </div>
  );
}
