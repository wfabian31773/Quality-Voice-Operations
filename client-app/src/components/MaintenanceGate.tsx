import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Maintenance from '../pages/Maintenance';

interface MaintenanceState {
  enabled: boolean;
  message: string | null;
  scheduled_for: string | null;
}

export default function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MaintenanceState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api
        .get<MaintenanceState>('/platform/maintenance')
        .then((data) => {
          if (!cancelled) setState(data);
        })
        .catch(() => {
          if (!cancelled) setState({ enabled: false, message: null, scheduled_for: null });
        });
    };
    check();
    const id = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (state?.enabled) {
    return <Maintenance message={state.message} scheduledFor={state.scheduled_for} />;
  }
  return <>{children}</>;
}
