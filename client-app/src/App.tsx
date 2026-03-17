import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import PublicLayout from './components/PublicLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import PhoneNumbers from './pages/PhoneNumbers';
import Calls from './pages/Calls';
import Connectors from './pages/Connectors';
import UsersPage from './pages/Users';
import Observability from './pages/Observability';
import Analytics from './pages/Analytics';
import RevenueAnalytics from './pages/RevenueAnalytics';
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
import PlatformAdminGuard from './components/PlatformAdminGuard';
import Operations from './pages/Operations';
import Insights from './pages/Insights';
import Workforce from './pages/Workforce';
import Improvements from './pages/Improvements';
import UpdateCenter from './pages/UpdateCenter';
import PostInstallSetup from './pages/PostInstallSetup';
import AcceptInvite from './pages/AcceptInvite';
import SimulationLab from './pages/SimulationLab';
import Autopilot from './pages/Autopilot';
import DigitalTwin from './pages/DigitalTwin';
import GlobalIntelligence from './pages/GlobalIntelligence';
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

const SETTINGS_TABS = ['general', 'security', 'api-keys'];

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
        <Route path="/agents" element={<AgentsShowcase />} />
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
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/operations" element={<Operations />} />
        <Route path="/workforce" element={<Workforce />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/phone-numbers" element={<PhoneNumbers />} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/observability" element={<Observability />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/revenue-analytics" element={<RevenueAnalytics />} />
        <Route path="/settings" element={<SettingsRedirect />} />
        <Route path="/settings/general" element={<Settings />} />
        <Route path="/settings/security" element={<Settings />} />
        <Route path="/settings/api-keys" element={<Settings />} />
        <Route path="/knowledge-base" element={<KnowledgeBase />} />
        <Route path="/quality" element={<Quality />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/autopilot" element={<Autopilot />} />
        <Route path="/simulation-lab" element={<SimulationLab />} />
        <Route path="/improvements" element={<Improvements />} />
        <Route path="/digital-twin" element={<DigitalTwin />} />
        <Route path="/global-intelligence" element={<GlobalIntelligence />} />
        <Route path="/widget" element={<Widget />} />
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/marketplace/installed" element={<Marketplace />} />
        <Route path="/marketplace/:id" element={<Marketplace />} />
        <Route path="/developer" element={<DeveloperPortal />} />
        <Route path="/audit-log" element={<AuditLog />} />
        <Route path="/marketplace/updates" element={<UpdateCenter />} />
        <Route path="/marketplace/installations/:installationId/setup" element={<PostInstallSetup />} />
        <Route path="/platform-admin" element={<PlatformAdminGuard><PlatformAdmin /></PlatformAdminGuard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
