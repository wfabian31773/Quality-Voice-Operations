import { useAuth } from '../lib/auth';
import OpsAccessDenied from './OpsAccessDenied';

export default function OpsGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const isOpsUser =
    user?.isPlatformAdmin ||
    user?.role === 'tenant_owner' ||
    user?.role === 'operations_manager';

  if (!isOpsUser) {
    return <OpsAccessDenied />;
  }

  return <>{children}</>;
}
