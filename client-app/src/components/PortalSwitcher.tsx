import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Building2, Shield, Radio, ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

interface Portal {
  id: 'tenant' | 'admin' | 'ops';
  icon: typeof Building2;
  path: string;
  badgeColor: string;
}

const portals: Portal[] = [
  {
    id: 'tenant',
    icon: Building2,
    path: '/dashboard',
    badgeColor: 'bg-info/30 text-on-sidebar',
  },
  {
    id: 'admin',
    icon: Shield,
    path: '/admin/dashboard',
    badgeColor: 'bg-accent/30 text-on-sidebar',
  },
  {
    id: 'ops',
    icon: Radio,
    path: '/ops/monitor',
    badgeColor: 'bg-success/30 text-on-sidebar',
  },
];

function getCurrentPortal(pathname: string): Portal {
  if (pathname.startsWith('/admin')) return portals[1];
  if (pathname.startsWith('/ops')) return portals[2];
  return portals[0];
}

export default function PortalSwitcher() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const isAdmin = user?.isPlatformAdmin;
  if (!isAdmin) return null;

  const current = getCurrentPortal(location.pathname);
  const others = portals.filter((p) => p.id !== current.id);
  const portalLabel = (id: Portal['id']) => t(`portal_switcher.${id}_label`);
  const portalBadge = (id: Portal['id']) => t(`portal_switcher.${id}_badge`);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div ref={ref} className="relative px-3 mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium text-sidebar-text hover:text-on-sidebar hover:bg-sidebar-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <current.icon className="h-3.5 w-3.5" />
          <span>{portalLabel(current.id)}</span>
        </div>
        <ChevronDown
          className={clsx(
            'h-3.5 w-3.5 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="absolute left-3 right-3 bottom-full mb-1 bg-sidebar-bg border border-on-sidebar/10 rounded-lg shadow-xl overflow-hidden z-dropdown">
          <p className="px-3 py-2 text-[10px] text-on-sidebar/70 uppercase tracking-wider font-semibold">
            {t('portal_switcher.switch_portal')}
          </p>
          {others.map((portal) => (
            <button
              key={portal.id}
              onClick={() => {
                navigate(portal.path);
                setOpen(false);
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-sidebar-text hover:text-on-sidebar hover:bg-sidebar-hover transition-colors"
            >
              <portal.icon className="h-4 w-4" />
              <span className="flex-1 text-left">{portalLabel(portal.id)}</span>
              <span
                className={clsx(
                  'text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wider',
                  portal.badgeColor,
                )}
              >
                {portalBadge(portal.id)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
