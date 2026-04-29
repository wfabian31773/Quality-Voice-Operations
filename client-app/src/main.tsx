import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import App from './App';
import i18n, { getLocaleFromPath } from './lib/i18n';
import './styles/tokens.css';
import './styles/tw-shell.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

// Compute the router basename from the URL prefix so all internal <Link>
// navigations stay inside the active locale (e.g. visiting /pt-BR/pricing
// keeps /pt-BR on every link click). The default locale (`en`) is canonically
// served from un-prefixed URLs, but `/en/...` is also accepted as an alias
// (basename = "/en") so older inbound links keep working without a redirect.
const initialLocale = getLocaleFromPath(window.location.pathname);
const basename = initialLocale ? `/${initialLocale}` : '/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <Suspense fallback={null}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter basename={basename}>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </Suspense>
    </I18nextProvider>
  </StrictMode>,
);
