import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function OpsGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const isOpsUser =
    user?.isPlatformAdmin ||
    user?.role === 'tenant_owner' ||
    user?.role === 'operations_manager';

  if (!isOpsUser) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
