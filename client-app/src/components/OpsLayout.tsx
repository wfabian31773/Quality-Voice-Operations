import '../styles/tw-app.css';
import {
  Radio,
  Bug,
  Plug2,
  Coins,
  ShieldCheck,
  Cpu,
  Repeat,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import GlobalScopeBanner from './GlobalScopeBanner';
import ConsoleShell from './console/ConsoleShell';
import type { NavGroup } from '../lib/roleLabel';

const OPS_GROUPS: NavGroup[] = [
  {
    i18nKey: 'admin_nav.ops_groups.live',
    items: [
      { to: '/ops/monitor', icon: Radio, i18nKey: 'admin_nav.ops.monitor', exact: true },
      { to: '/ops/reliability', icon: ShieldCheck, i18nKey: 'admin_nav.ops.reliability' },
    ],
  },
  {
    i18nKey: 'admin_nav.ops_groups.investigation',
    items: [
      { to: '/ops/call-debug', icon: Bug, i18nKey: 'admin_nav.ops.debugger' },
      { to: '/ops/integration-diagnostics', icon: Plug2, i18nKey: 'admin_nav.ops.diagnostics' },
      { to: '/ops/cost', icon: Coins, i18nKey: 'admin_nav.ops.cost' },
      { to: '/ops/digital-twin', icon: Cpu, i18nKey: 'admin_nav.ops.digital_twin' },
    ],
  },
  {
    i18nKey: 'admin_nav.ops_groups.data',
    items: [
      { to: '/ops/backfill-calls', icon: Repeat, i18nKey: 'admin_nav.ops.backfill_calls' },
    ],
  },
];

export default function OpsLayout() {
  const { t } = useTranslation();
  return (
    <ConsoleShell
      badge={{
        label: 'admin_nav.ops_badge',
        accentClass: 'bg-success/30',
        dotClass: 'bg-success',
        pillClass: 'border border-success/40 bg-success-light text-success',
      }}
      navGroups={OPS_GROUPS}
      navAriaLabel={t('admin_nav.ops_console')}
      headerTitle={t('admin_nav.ops_console')}
      headerTitleShort={t('admin_nav.ops_badge')}
      belowHeaderBanner={<GlobalScopeBanner variant="global" compact />}
    />
  );
}
