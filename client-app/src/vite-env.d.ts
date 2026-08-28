/** Bundler-handled assets. Required now that TypeScript checks side-effect imports. */
declare module '*.css';

/**
 * Vite replaces `process.env.NODE_ENV` at build time. CI typecheck may run
 * without `@types/node` (client-app does not depend on it).
 */
declare const process: {
  env: {
    NODE_ENV?: string;
  };
};
