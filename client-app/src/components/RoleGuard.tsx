import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function RoleGuard({ allowedRoles, children }: { allowedRoles: string[]; children: React.ReactNode }) {
  const { user } = useAuth();

  if (!user || !allowedRoles.includes(user.role ?? '')) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
