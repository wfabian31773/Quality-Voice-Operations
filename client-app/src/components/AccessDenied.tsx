import { ShieldX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface AccessDeniedProps {
  message?: string;
}

export default function AccessDenied({ message }: AccessDeniedProps) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center py-20 px-4">
      <div className="bg-danger/10 p-4 rounded-full mb-4">
        <ShieldX className="h-10 w-10 text-danger" />
      </div>
      <h2 className="text-xl font-semibold text-text-primary mb-2">Access Denied</h2>
      <p className="text-sm text-text-secondary text-center max-w-md mb-6">
        {message ?? 'You do not have permission to view this page. Contact your organization owner to request access.'}
      </p>
      <button
        onClick={() => navigate('/dashboard')}
        className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition"
      >
        Go to Dashboard
      </button>
    </div>
  );
}
