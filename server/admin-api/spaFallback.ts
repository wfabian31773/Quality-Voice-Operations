import express, { type Express } from 'express';
import path from 'path';
import fs from 'fs';
import { isMarketingPathname } from '../../shared/spa/marketingRoutes';

export function isProductionBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.APP_ENV === 'production';
}

/**
 * Mounts static assets and the SPA history fallback for the production server.
 *
 * The build emits two SPA bundles:
 *   - `<clientDistPath>/index.html`           — full React in-app bundle
 *   - `<clientDistPath>/public/index.public.html` — Preact-based marketing bundle
 *
 * For HTML navigations (`req.accepts('html')`), the fallback inspects the URL
 * with `isMarketingPathname()` so visitors landing on `/`, `/pricing`,
 * `/blog/*`, etc. download the lightweight marketing bundle. Every other URL
 * (in-app, auth, agent-builder, ops, admin, etc.) keeps using the React
 * bundle — there are zero behavioral changes for those surfaces.
 *
 * Hashed asset URLs (under `/assets/` for the in-app bundle and
 * `/public/assets/` for the marketing bundle) are served by `express.static`
 * directly and never hit the fallback.
 */
export function attachSpaFallback(app: Express, clientDistPath: string): boolean {
  if (!fs.existsSync(clientDistPath)) {
    return false;
  }

  const marketingDistPath = path.join(clientDistPath, 'public');
  const marketingHtmlPath = path.join(marketingDistPath, 'index.public.html');
  const marketingHtmlExists = fs.existsSync(marketingHtmlPath);

  // Serve marketing assets first under their own URL prefix so they don't
  // collide with the in-app bundle's `/assets/*` files. The marketing build
  // emits assets at `dist/public/assets/*`; mounting it at `/public` keeps the
  // hashed URLs in `index.public.html` (e.g. `/assets/...`) resolvable when
  // combined with the marketing-aware fallback below, which lets requests for
  // `/assets/<hash>.js` fall through to the in-app static handler when the
  // file isn't under `dist/public`.
  // Disable directory-index serving on both static handlers so requests for
  // bare paths like `/` always fall through to the SPA history handler below
  // — otherwise `express.static` would short-circuit `/` to `dist/index.html`
  // and visitors who should land on the marketing bundle would get the
  // (heavier) in-app one instead.
  if (marketingHtmlExists) {
    app.use('/public', express.static(marketingDistPath, { index: false }));
  }
  app.use(express.static(clientDistPath, { index: false }));

  // Express 5's `/*splat` only matches paths with at least one segment, so we
  // also register a handler for the bare `/` to keep the marketing landing
  // page reachable from the SPA fallback.
  const spaHandler: express.RequestHandler = (req, res) => {
    if (
      marketingHtmlExists &&
      req.accepts('html') &&
      isMarketingPathname(req.path)
    ) {
      res.sendFile(marketingHtmlPath);
      return;
    }
    res.sendFile(path.join(clientDistPath, 'index.html'));
  };
  app.get('/', spaHandler);
  app.get('/*splat', spaHandler);
  return true;
}
