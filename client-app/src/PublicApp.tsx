import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import MaintenanceGate from './components/MaintenanceGate';
import PageSkeleton from './components/PageSkeleton';
import ScrollToTop from './components/ScrollToTop';

// Marketing-only Routes tree. Mirrors the public routes in `App.tsx` so that
// every URL the server forwards to `index.public.html` resolves correctly. The
// in-app App.tsx keeps the same routes too (so dev mode + deep-link fallbacks
// still work) — at build time the marketing pages here are tree-shaken into
// the Preact bundle and into the React bundle independently.

const PublicLayout = lazy(() => import('./components/PublicLayout'));
const Landing = lazy(() => import('./pages/public/Landing'));
const Pricing = lazy(() => import('./pages/public/Pricing'));
const Contact = lazy(() => import('./pages/public/Contact'));
const VerticalLanding = lazy(() => import('./pages/public/VerticalLanding'));
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
        {/* Reset scroll on every forward navigation. See ScrollToTop.tsx
            for the back/forward + hash-link edge case handling. */}
        <ScrollToTop />
        <Suspense fallback={<PageSkeleton />}>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route path="/" element={<Landing />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/demo" element={<Demo />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/industries/healthcare" element={<VerticalLanding />} />
              <Route path="/industries/dental" element={<VerticalLanding />} />
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
