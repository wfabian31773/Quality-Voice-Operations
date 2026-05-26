import { Component, ReactNode } from 'react';
import ServerError from '../pages/ServerError';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** sessionStorage key used to break the infinite-reload loop if a chunk
 * fetch keeps failing (e.g. the deploy actually 404s a chunk that never
 * existed). After one auto-reload attempt per session, we let the 500
 * page render so the user can see the real failure. */
const CHUNK_RELOAD_FLAG = 'qvo:chunk-reload-attempted';

/** Heuristic: does this error look like a stale-shell-vs-new-deploy
 * dynamic-import failure? Chrome/Firefox/Safari each produce slightly
 * different messages; we match all known shapes plus the canonical
 * webpack `ChunkLoadError` for safety. */
function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; message?: string };
  if (e.name === 'ChunkLoadError') return true;
  const msg = e.message ?? '';
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Loading chunk [\w-]+ failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  );
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[ErrorBoundary]', error, info?.componentStack);

    // Stale-shell-vs-new-deploy recovery: Vite's `lazy()` chunks ship
    // with hashed filenames, and every new deploy regenerates the
    // hashes. Any browser holding the previous app shell will 404 on
    // the next route change because the chunk URL it has cached is
    // gone. Auto-reload once to fetch the new shell + new chunk hashes
    // — that's typically all it takes.
    //
    // The session flag prevents an infinite reload loop if the new
    // build is itself broken: we retry exactly ONCE per browser
    // session, then fall through to the 500 page so the user can see
    // Try Again rather than a reload spinner forever.
    if (isChunkLoadError(error)) {
      try {
        if (sessionStorage.getItem(CHUNK_RELOAD_FLAG) !== '1') {
          sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
          window.location.reload();
          return;
        }
      } catch {
        // sessionStorage can throw in private modes / some embeds. If
        // it does we just fall through to the 500 page below — at least
        // the user gets the Try Again button rather than a blank screen.
      }
    }
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return <ServerError error={this.state.error} onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
