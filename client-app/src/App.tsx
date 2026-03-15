import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import PhoneNumbers from './pages/PhoneNumbers';
import Calls from './pages/Calls';
import Connectors from './pages/Connectors';
import UsersPage from './pages/Users';
import Observability from './pages/Observability';
import Analytics from './pages/Analytics';
import Onboarding from './pages/Onboarding';
import Demo from './pages/Demo';
import ApiKeys from './pages/ApiKeys';
import Quality from './pages/Quality';
import AuditLog from './pages/AuditLog';
import PlatformAdmin from './pages/PlatformAdmin';
import PlatformAdminGuard from './components/PlatformAdminGuard';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/demo" element={<Demo />} />
      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            <Onboarding />
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
        <Route path="/" element={<Dashboard />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/phone-numbers" element={<PhoneNumbers />} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/observability" element={<Observability />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/settings/api-keys" element={<ApiKeys />} />
        <Route path="/quality" element={<Quality />} />
        <Route path="/audit-log" element={<AuditLog />} />
        <Route path="/platform-admin" element={<PlatformAdminGuard><PlatformAdmin /></PlatformAdminGuard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
