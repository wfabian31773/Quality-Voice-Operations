import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import TenantLayout from './components/TenantLayout';
import AdminLayout from './components/AdminLayout';
import OpsLayout from './components/OpsLayout';
import PublicLayout from './components/PublicLayout';
import PlatformAdminGuard from './components/PlatformAdminGuard';
import OpsGuard from './components/OpsGuard';
import RoleGuard from './components/RoleGuard';
import ErrorBoundary from './components/ErrorBoundary';
import MaintenanceGate from './components/MaintenanceGate';
import PlatformAssistant from './components/PlatformAssistant';
import PageSkeleton from './components/PageSkeleton';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Agents = lazy(() => import('./pages/Agents'));
const PhoneNumbers = lazy(() => import('./pages/PhoneNumbers'));
const TrustedCallers = lazy(() => import('./pages/TrustedCallers'));
const Calls = lazy(() => import('./pages/Calls'));
const Connectors = lazy(() => import('./pages/Connectors'));
const UsersPage = lazy(() => import('./pages/Users'));
const Analytics = lazy(() => import('./pages/Analytics'));
const AdminAnalytics = lazy(() => import('./pages/AdminAnalytics'));
const AdminTenantAnalytics = lazy(() => import('./pages/AdminTenantAnalytics'));
const AdminTenantCalls = lazy(() => import('./pages/AdminTenantCalls'));
const AdminTenantCampaign = lazy(() => import('./pages/AdminTenantCampaign'));
const AdminMarketplace = lazy(() => import('./pages/AdminMarketplace'));
const AdminSalesInbox = lazy(() => import('./pages/AdminSalesInbox'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Demo = lazy(() => import('./pages/Demo'));
const Campaigns = lazy(() => import('./pages/Campaigns'));
const Billing = lazy(() => import('./pages/Billing'));
const Settings = lazy(() => import('./pages/Settings'));
const Quality = lazy(() => import('./pages/Quality'));
const AuditLog = lazy(() => import('./pages/AuditLog'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'));
const Widget = lazy(() => import('./pages/Widget'));
const AgentBuilder = lazy(() => import('./pages/AgentBuilder'));
const Marketplace = lazy(() => import('./pages/Marketplace'));
const DeveloperPortal = lazy(() => import('./pages/DeveloperPortal'));
const PlatformAdmin = lazy(() => import('./pages/PlatformAdmin'));
const Operations = lazy(() => import('./pages/Operations'));
const UpdateCenter = lazy(() => import('./pages/UpdateCenter'));
const PostInstallSetup = lazy(() => import('./pages/PostInstallSetup'));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const DigitalTwin = lazy(() => import('./pages/DigitalTwin'));
const Governance = lazy(() => import('./pages/Governance'));
const ToolHealth = lazy(() => import('./pages/ToolHealth'));
const CostOptimization = lazy(() => import('./pages/CostOptimization'));
const CallDebug = lazy(() => import('./pages/CallDebug'));
const Compliance = lazy(() => import('./pages/Compliance'));
const PlatformCompliance = lazy(() => import('./pages/admin/PlatformCompliance'));
const IngestBackfill = lazy(() => import('./pages/admin/IngestBackfill'));
const Autopilot = lazy(() => import('./pages/Autopilot'));
const IntegrationDiagnostics = lazy(() => import('./pages/IntegrationDiagnostics'));
const Workflows = lazy(() => import('./pages/Workflows'));
const SmsInbox = lazy(() => import('./pages/SmsInbox'));
const Scheduling = lazy(() => import('./pages/Scheduling'));
const Tickets = lazy(() => import('./pages/Tickets'));
const TicketDetail = lazy(() => import('./pages/TicketDetail'));
const TicketReporting = lazy(() => import('./pages/TicketReporting'));
const TicketAdmin = lazy(() => import('./pages/TicketAdmin'));
const Dispatch = lazy(() => import('./pages/Dispatch'));
const NotFound = lazy(() => import('./pages/NotFound'));
const Changelog = lazy(() => import('./pages/Changelog'));

const Landing = lazy(() => import('./pages/public/Landing'));
const Product = lazy(() => import('./pages/public/Product'));
const Features = lazy(() => import('./pages/public/Features'));
const Pricing = lazy(() => import('./pages/public/Pricing'));
const UseCases = lazy(() => import('./pages/public/UseCases'));
const Integrations = lazy(() => import('./pages/public/Integrations'));
const Contact = lazy(() => import('./pages/public/Contact'));
const Docs = lazy(() => import('./pages/public/Docs'));
const DocArticle = lazy(() => import('./pages/public/DocArticle'));
const AgentsShowcase = lazy(() => import('./pages/public/AgentsShowcase'));
const Signup = lazy(() => import('./pages/public/Signup'));
const VerifyEmail = lazy(() => import('./pages/public/VerifyEmail'));
const Blog = lazy(() => import('./pages/public/Blog'));
const BlogArticle = lazy(() => import('./pages/public/BlogArticle'));
const Resources = lazy(() => import('./pages/public/Resources'));
const GuideDetail = lazy(() => import('./pages/public/GuideDetail'));
const VerticalLanding = lazy(() => import('./pages/public/VerticalLanding'));
const VerticalAgents = lazy(() => import('./pages/public/VerticalAgents'));
const FederatedIngest = lazy(() => import('./pages/public/FederatedIngest'));
const GlobalIntelligenceNetwork = lazy(() => import('./pages/public/GlobalIntelligenceNetwork'));
const CaseStudies = lazy(() => import('./pages/public/CaseStudies'));
const BookDemo = lazy(() => import('./pages/public/BookDemo'));
const Terms = lazy(() => import('./pages/public/Terms'));
const Privacy = lazy(() => import('./pages/public/Privacy'));
const Security = lazy(() => import('./pages/public/Security'));
const SecurityPosture = lazy(() => import('./pages/public/SecurityPosture'));
const Subprocessors = lazy(() => import('./pages/public/Subprocessors'));

const SETTINGS_TABS = ['general', 'notifications', 'roles', 'security', 'api-keys', 'privacy'];

function SettingsRedirect() {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  if (tab && SETTINGS_TABS.includes(tab)) {
    return <Navigate to={`/settings/${tab}`} replace />;
  }
  return <Navigate to="/settings/general" replace />;
}

export default function App() {
  return (
    <ErrorBoundary>
    <MaintenanceGate>
    <Suspense fallback={<PageSkeleton />}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/auth/verify-email" element={<VerifyEmail />} />

      <Route element={<PublicLayout />}>
        <Route path="/" element={<Landing />} />
        <Route path="/product" element={<Product />} />
        <Route path="/product/federated-ingest" element={<FederatedIngest />} />
        <Route path="/product/global-intelligence-network" element={<GlobalIntelligenceNetwork />} />
        <Route path="/features" element={<Features />} />
        <Route path="/ai-agents" element={<AgentsShowcase />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/use-cases" element={<UseCases />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:slug" element={<DocArticle />} />
        <Route path="/resources" element={<Resources />} />
        <Route path="/resources/:slug" element={<GuideDetail />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/blog/:slug" element={<BlogArticle />} />
        <Route path="/industries/vertical-agents" element={<VerticalAgents />} />
        <Route path="/industries/:vertical" element={<VerticalLanding />} />
        <Route path="/case-studies" element={<CaseStudies />} />
        <Route path="/case-studies/:slug" element={<CaseStudies />} />
        <Route path="/book-demo" element={<BookDemo />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/security" element={<Security />} />
        <Route path="/security/posture" element={<SecurityPosture />} />
        <Route path="/subprocessors" element={<Subprocessors />} />
      </Route>

      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            <>
              <Onboarding />
              <PlatformAssistant />
            </>
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents/:id/builder"
        element={
          <ProtectedRoute>
            <>
              <AgentBuilder />
              <PlatformAssistant />
            </>
          </ProtectedRoute>
        }
      />

      {/* Tenant Portal */}
      <Route
        element={
          <ProtectedRoute>
            <TenantLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/workflows" element={<RoleGuard minRole="manager"><Workflows /></RoleGuard>} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/knowledge-base" element={<KnowledgeBase />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/marketplace/installed" element={<Marketplace />} />
        <Route path="/marketplace/:id" element={<Marketplace />} />
        <Route path="/marketplace/updates" element={<UpdateCenter />} />
        <Route path="/marketplace/installations/:installationId/setup" element={<PostInstallSetup />} />
        <Route path="/settings" element={<SettingsRedirect />} />
        <Route path="/settings/:tab" element={<Settings />} />
        <Route path="/phone-numbers" element={<PhoneNumbers />} />
        <Route path="/trusted-callers" element={<RoleGuard minRole="operator"><TrustedCallers /></RoleGuard>} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/quality" element={<Quality />} />
        <Route path="/audit-log" element={<RoleGuard minRole="manager"><AuditLog /></RoleGuard>} />
        <Route path="/compliance" element={<RoleGuard minRole="manager"><Compliance /></RoleGuard>} />
        <Route path="/widget" element={<Widget />} />
        <Route path="/developer" element={<DeveloperPortal />} />
        <Route path="/sms-inbox" element={<SmsInbox />} />
        <Route path="/scheduling" element={<Scheduling />} />
        <Route path="/tickets" element={<Tickets />} />
        <Route path="/tickets/reporting" element={<TicketReporting />} />
        <Route path="/tickets/admin" element={<RoleGuard minRole="manager"><TicketAdmin /></RoleGuard>} />
        <Route path="/tickets/:id" element={<TicketDetail />} />
        <Route path="/dispatch" element={<Dispatch />} />
        <Route path="/autopilot" element={<RoleGuard minRole="manager"><Autopilot /></RoleGuard>} />
        <Route path="/changelog" element={<Changelog />} />
      </Route>

      {/* Platform Admin Console */}
      <Route
        element={
          <ProtectedRoute>
            <PlatformAdminGuard>
              <AdminLayout />
            </PlatformAdminGuard>
          </ProtectedRoute>
        }
      >
        <Route path="/admin/dashboard" element={<PlatformAdmin />} />
        <Route path="/admin/analytics" element={<AdminAnalytics />} />
        <Route path="/admin/analytics/tenants/:tenantId" element={<AdminTenantAnalytics />} />
        <Route path="/admin/analytics/tenants/:tenantId/calls" element={<AdminTenantCalls />} />
        <Route path="/admin/analytics/tenants/:tenantId/campaigns/:campaignId" element={<AdminTenantCampaign />} />
        <Route path="/admin/marketplace" element={<AdminMarketplace />} />
        <Route path="/admin/sales-inbox" element={<AdminSalesInbox />} />
        <Route path="/admin/billing" element={<Billing />} />
        <Route path="/admin/security" element={<PlatformCompliance />} />
        <Route path="/admin/governance" element={<Governance />} />
        <Route path="/admin/evolution" element={<Navigate to="/admin/governance?tab=evolution" replace />} />
        <Route path="/admin/conversion" element={<Navigate to="/admin/governance?tab=funnel" replace />} />
        <Route path="/admin/intelligence" element={<Navigate to="/admin/governance?tab=intelligence" replace />} />
        <Route path="/admin/ingest-backfill" element={<IngestBackfill />} />
      </Route>

      {/* Operations Console */}
      <Route
        element={
          <ProtectedRoute>
            <OpsGuard>
              <OpsLayout />
            </OpsGuard>
          </ProtectedRoute>
        }
      >
        <Route path="/ops/monitor" element={<Operations />} />
        <Route path="/ops/call-debug" element={<CallDebug />} />
        <Route path="/ops/integration-diagnostics" element={<IntegrationDiagnostics />} />
        <Route path="/ops/cost" element={<CostOptimization />} />
        <Route path="/ops/reliability" element={<ToolHealth />} />
        <Route path="/ops/digital-twin" element={<DigitalTwin />} />
      </Route>

      {/* Legacy redirects kept for backward-compatible deep links */}
      <Route path="/revenue-analytics" element={<Navigate to="/analytics" replace />} />
      <Route path="/ops/tool-logs" element={<Navigate to="/ops/reliability" replace />} />
      <Route path="/ops/observability" element={<Navigate to="/ops/reliability" replace />} />

      <Route path="*" element={<NotFound />} />
    </Routes>
    </Suspense>
    </MaintenanceGate>
    </ErrorBoundary>
  );
}
