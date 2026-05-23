import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import MaintenanceGate from './components/MaintenanceGate';
import PageSkeleton from './components/PageSkeleton';

// Marketing-only Routes tree. Mirrors the public routes in `App.tsx` so that
// every URL the server forwards to `index.public.html` resolves correctly. The
// in-app App.tsx keeps the same routes too (so dev mode + deep-link fallbacks
// still work) — at build time the marketing pages here are tree-shaken into
// the Preact bundle and into the React bundle independently.

const PublicLayout = lazy(() => import('./components/PublicLayout'));
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
const Blog = lazy(() => import('./pages/public/Blog'));
const BlogArticle = lazy(() => import('./pages/public/BlogArticle'));
const Resources = lazy(() => import('./pages/public/Resources'));
const GuideDetail = lazy(() => import('./pages/public/GuideDetail'));
const VerticalLanding = lazy(() => import('./pages/public/VerticalLanding'));
const VerticalAgents = lazy(() => import('./pages/public/VerticalAgents'));
const FederatedIngest = lazy(() => import('./pages/public/FederatedIngest'));
const CaseStudies = lazy(() => import('./pages/public/CaseStudies'));
const BookDemo = lazy(() => import('./pages/public/BookDemo'));
const Terms = lazy(() => import('./pages/public/Terms'));
const Privacy = lazy(() => import('./pages/public/Privacy'));
const Security = lazy(() => import('./pages/public/Security'));
const SecurityPosture = lazy(() => import('./pages/public/SecurityPosture'));
const Subprocessors = lazy(() => import('./pages/public/Subprocessors'));
const Demo = lazy(() => import('./pages/Demo'));
const NotFound = lazy(() => import('./pages/NotFound'));

export default function PublicApp() {
  return (
    <ErrorBoundary>
      <MaintenanceGate>
        <Suspense fallback={<PageSkeleton />}>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route path="/" element={<Landing />} />
              <Route path="/product" element={<Product />} />
              <Route path="/product/federated-ingest" element={<FederatedIngest />} />
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
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </MaintenanceGate>
    </ErrorBoundary>
  );
}
