import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function PlatformAdminGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  if (!user?.isPlatformAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
