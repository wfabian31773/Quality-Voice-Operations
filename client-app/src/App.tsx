import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import TenantLayout from './components/TenantLayout';
import AdminLayout from './components/AdminLayout';
import OpsLayout from './components/OpsLayout';
import PublicLayout from './components/PublicLayout';
import PlatformAdminGuard from './components/PlatformAdminGuard';
import OpsGuard from './components/OpsGuard';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import PhoneNumbers from './pages/PhoneNumbers';
import Calls from './pages/Calls';
import Connectors from './pages/Connectors';
import UsersPage from './pages/Users';
import Analytics from './pages/Analytics';
import Onboarding from './pages/Onboarding';
import Demo from './pages/Demo';
import Campaigns from './pages/Campaigns';
import Billing from './pages/Billing';
import Settings from './pages/Settings';
import Quality from './pages/Quality';
import AuditLog from './pages/AuditLog';
import KnowledgeBase from './pages/KnowledgeBase';
import Widget from './pages/Widget';
import AgentBuilder from './pages/AgentBuilder';
import Marketplace from './pages/Marketplace';
import DeveloperPortal from './pages/DeveloperPortal';
import PlatformAdmin from './pages/PlatformAdmin';
import Operations from './pages/Operations';
import UpdateCenter from './pages/UpdateCenter';
import PostInstallSetup from './pages/PostInstallSetup';
import AcceptInvite from './pages/AcceptInvite';
import DigitalTwin from './pages/DigitalTwin';
import GlobalIntelligence from './pages/GlobalIntelligence';
import EvolutionEngine from './pages/EvolutionEngine';
import ToolHealth from './pages/ToolHealth';
import CostOptimization from './pages/CostOptimization';
import CallDebug from './pages/CallDebug';
import Compliance from './pages/Compliance';
import IntegrationDiagnostics from './pages/IntegrationDiagnostics';
import PlatformAssistant from './components/PlatformAssistant';
import Landing from './pages/public/Landing';
import Product from './pages/public/Product';
import Features from './pages/public/Features';
import Pricing from './pages/public/Pricing';
import UseCases from './pages/public/UseCases';
import Integrations from './pages/public/Integrations';
import Contact from './pages/public/Contact';
import Docs from './pages/public/Docs';
import AgentsShowcase from './pages/public/AgentsShowcase';
import Signup from './pages/public/Signup';
import VerifyEmail from './pages/public/VerifyEmail';
import Blog from './pages/public/Blog';
import BlogArticle from './pages/public/BlogArticle';
import Resources from './pages/public/Resources';
import GuideDetail from './pages/public/GuideDetail';
import VerticalLanding from './pages/public/VerticalLanding';
import CaseStudies from './pages/public/CaseStudies';
import BookDemo from './pages/public/BookDemo';
import Terms from './pages/public/Terms';
import Privacy from './pages/public/Privacy';
import Security from './pages/public/Security';
import Subprocessors from './pages/public/Subprocessors';
import ConversionFunnel from './pages/ConversionFunnel';
import Workflows from './pages/Workflows';
import RoleGuard from './components/RoleGuard';
import SmsInbox from './pages/SmsInbox';
import Scheduling from './pages/Scheduling';
import Tickets from './pages/Tickets';
import TicketDetail from './pages/TicketDetail';
import TicketReporting from './pages/TicketReporting';
import TicketAdmin from './pages/TicketAdmin';
import Dispatch from './pages/Dispatch';

const SETTINGS_TABS = ['general', 'roles', 'security', 'api-keys', 'privacy'];

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
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/auth/verify-email" element={<VerifyEmail />} />

      <Route element={<PublicLayout />}>
        <Route path="/" element={<Landing />} />
        <Route path="/product" element={<Product />} />
        <Route path="/features" element={<Features />} />
        <Route path="/ai-agents" element={<AgentsShowcase />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/use-cases" element={<UseCases />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/resources" element={<Resources />} />
        <Route path="/resources/:slug" element={<GuideDetail />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/blog/:slug" element={<BlogArticle />} />
        <Route path="/industries/:vertical" element={<VerticalLanding />} />
        <Route path="/case-studies" element={<CaseStudies />} />
        <Route path="/case-studies/:slug" element={<CaseStudies />} />
        <Route path="/book-demo" element={<BookDemo />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/security" element={<Security />} />
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
        <Route path="/settings/general" element={<Settings />} />
        <Route path="/settings/roles" element={<Settings />} />
        <Route path="/settings/security" element={<Settings />} />
        <Route path="/settings/api-keys" element={<Settings />} />
        <Route path="/settings/privacy" element={<Settings />} />
        <Route path="/phone-numbers" element={<PhoneNumbers />} />
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
        <Route path="/admin/analytics" element={<Analytics />} />
        <Route path="/admin/marketplace" element={<Marketplace />} />
        <Route path="/admin/billing" element={<Billing />} />
        <Route path="/admin/security" element={<Compliance />} />
        <Route path="/admin/evolution" element={<EvolutionEngine />} />
        <Route path="/admin/conversion" element={<ConversionFunnel />} />
        <Route path="/admin/intelligence" element={<GlobalIntelligence />} />
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

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
