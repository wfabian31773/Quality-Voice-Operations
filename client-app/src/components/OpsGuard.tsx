import { useAuth } from '../lib/auth';
import OpsAccessDenied from './OpsAccessDenied';
import { isQvoStaff } from '../lib/surfacePolicy';

export default function OpsGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const isOpsUser = isQvoStaff(user);

  if (!isOpsUser) {
    return <OpsAccessDenied />;
  }

  return <>{children}</>;
}
