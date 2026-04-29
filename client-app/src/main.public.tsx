import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import PublicApp from './PublicApp';
import i18n, { getLocaleFromPath } from './lib/i18n';
import './styles/tokens.css';
import './styles/tw-shell.css';

// Marketing-only entry. The Vite config aliases `react`, `react-dom`, and
// `react-dom/client` to `preact/compat`, so the imports above resolve to the
// Preact runtime at build time. The eager preload graph for visitors landing on
// `/`, `/pricing`, etc. is therefore much smaller than the React-based in-app
// bundle (see `docs/perf/baseline.md`). The in-app bundle (`main.tsx`) keeps
// using full React.

const initialLocale = getLocaleFromPath(window.location.pathname);
const basename = initialLocale ? `/${initialLocale}` : '/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <Suspense fallback={null}>
        <BrowserRouter basename={basename}>
          <PublicApp />
        </BrowserRouter>
      </Suspense>
    </I18nextProvider>
  </StrictMode>,
);
