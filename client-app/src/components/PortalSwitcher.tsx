import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Building2, Shield, Radio, ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import clsx from 'clsx';

interface Portal {
  id: string;
  label: string;
  badge: string;
  icon: typeof Building2;
  path: string;
  badgeColor: string;
  hoverColor: string;
}

const portals: Portal[] = [
  {
    id: 'tenant',
    label: 'Tenant Portal',
    badge: 'Tenant',
    icon: Building2,
    path: '/dashboard',
    badgeColor: 'bg-blue-500/20 text-blue-300',
    hoverColor: 'hover:bg-white/5',
  },
  {
    id: 'admin',
    label: 'Platform Admin',
    badge: 'Admin',
    icon: Shield,
    path: '/admin/dashboard',
    badgeColor: 'bg-purple-500/20 text-purple-300',
    hoverColor: 'hover:bg-white/5',
  },
  {
    id: 'ops',
    label: 'Operations',
    badge: 'Ops',
    icon: Radio,
    path: '/ops/monitor',
    badgeColor: 'bg-emerald-500/20 text-emerald-300',
    hoverColor: 'hover:bg-white/5',
  },
];

function getCurrentPortal(pathname: string): Portal {
  if (pathname.startsWith('/admin')) return portals[1];
  if (pathname.startsWith('/ops')) return portals[2];
  return portals[0];
}

export default function PortalSwitcher() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const isAdmin = user?.isPlatformAdmin;
  if (!isAdmin) return null;

  const current = getCurrentPortal(location.pathname);
  const others = portals.filter((p) => p.id !== current.id);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div ref={ref} className="relative px-3 mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white/70 hover:text-white hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <current.icon className="h-3.5 w-3.5" />
          <span>{current.label}</span>
        </div>
        <ChevronDown
          className={clsx(
            'h-3.5 w-3.5 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="absolute left-3 right-3 bottom-full mb-1 bg-[#1a2d3d] border border-white/10 rounded-lg shadow-xl overflow-hidden z-50">
          <p className="px-3 py-2 text-[10px] text-white/40 uppercase tracking-wider font-semibold">
            Switch Portal
          </p>
          {others.map((portal) => (
            <button
              key={portal.id}
              onClick={() => {
                navigate(portal.path);
                setOpen(false);
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-white/80 hover:text-white hover:bg-white/5 transition-colors"
            >
              <portal.icon className="h-4 w-4" />
              <span className="flex-1 text-left">{portal.label}</span>
              <span
                className={clsx(
                  'text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wider',
                  portal.badgeColor,
                )}
              >
                {portal.badge}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
