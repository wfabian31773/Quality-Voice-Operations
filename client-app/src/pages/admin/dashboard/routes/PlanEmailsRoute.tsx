import { useNavigate } from 'react-router-dom';
import { PlanRecommendationEmailsTab } from '../../../PlatformAdmin';

/**
 * The plan-emails tab has a "view tenant" affordance on each row that
 * jumps into the tenants tab with the requested tenant pre-expanded.
 * Cross-tab navigation goes through the URL (`/admin/dashboard/tenants?expand=<id>`);
 * TenantsTable picks up `?expand=` on mount.
 */
export default function PlanEmailsRoute() {
  const navigate = useNavigate();
  return (
    <PlanRecommendationEmailsTab
      onViewTenant={(tenantId) => {
        navigate(`/admin/dashboard/tenants?expand=${encodeURIComponent(tenantId)}`);
      }}
    />
  );
}
