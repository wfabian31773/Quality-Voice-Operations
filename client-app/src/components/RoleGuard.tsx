import { useRole, type SimpleRole } from '../lib/useRole';
import AccessDenied from './AccessDenied';

interface RoleGuardProps {
  minRole: SimpleRole;
  children: React.ReactNode;
}

export default function RoleGuard({ minRole, children }: RoleGuardProps) {
  const { hasMinRole } = useRole();

  if (!hasMinRole(minRole)) {
    return <AccessDenied />;
  }

  return <>{children}</>;
}
