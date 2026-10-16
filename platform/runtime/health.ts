/**
 * Liveness and readiness probes shared by the admin API and the voice
 * gateway (PR-00, Render migration). See docs/deploy/render.md §Health.
 *
 *   /healthz  Liveness only. Never touches the DB, xAI or Twilio. 200 while
 *             the process is serving, including while it drains. This is
 *             Render's healthCheckPath, so a DB blip can never get a live
 *             voice instance marked unhealthy.
 *   /readyz   200 only when the env is valid for this role, `SELECT 1`
 *             answers within 1 s, the tool registries are loaded and the
 *             process is not draining. Otherwise 503 with reason codes
 *             (never values).
 *
 * The existing `/health` routes are unchanged.
 */
import { Router } from 'express';
import type { ProcessRole } from './processRole';

export type ReadinessReason =
  | 'env_invalid'
  | 'env_not_validated'
  | 'db_unreachable'
  | 'db_timeout'
  | 'registries_not_loaded'
  | 'draining';

interface ReadinessState {
  envValid: boolean | null;
  registriesLoaded: boolean;
  draining: boolean;
}

const state: ReadinessState = {
  envValid: null,
  registriesLoaded: false,
  draining: false,
};

export function markEnvValidated(passed: boolean): void {
  state.envValid = passed;
}

export function markRegistriesLoaded(): void {
  state.registriesLoaded = true;
}

export function markDraining(): void {
  state.draining = true;
}

export function isProcessDraining(): boolean {
  return state.draining;
}

export function __resetReadinessForTests(): void {
  state.envValid = null;
  state.registriesLoaded = false;
  state.draining = false;
}

export interface ProbeOptions {
  service: 'admin-api' | 'voice-gateway';
  role: () => ProcessRole;
  /** Runs `SELECT 1`; must reject on failure. */
  dbPing: () => Promise<unknown>;
  /** Extra draining signal (voice: the session manager). */
  isDraining?: () => boolean;
  dbTimeoutMs?: number;
}

async function checkDb(ping: () => Promise<unknown>, timeoutMs: number): Promise<ReadinessReason | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const query = Promise.resolve()
    .then(ping)
    .then(
      () => 'ok' as const,
      () => 'error' as const,
    );
  try {
    const outcome = await Promise.race([query, timeout]);
    if (outcome === 'timeout') return 'db_timeout';
    if (outcome === 'error') return 'db_unreachable';
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createProbeRouter(opts: ProbeOptions): Router {
  const router = Router();
  const dbTimeoutMs = opts.dbTimeoutMs ?? 1_000;

  router.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', service: opts.service });
  });

  router.get('/readyz', async (_req, res) => {
    const reasons: ReadinessReason[] = [];
    if (state.envValid === false) reasons.push('env_invalid');
    else if (state.envValid === null) reasons.push('env_not_validated');
    if (!state.registriesLoaded) reasons.push('registries_not_loaded');
    const draining = state.draining || (opts.isDraining?.() ?? false);
    if (draining) reasons.push('draining');
    const dbReason = await checkDb(opts.dbPing, dbTimeoutMs);
    if (dbReason) reasons.push(dbReason);

    res.set('Cache-Control', 'no-store');
    res.status(reasons.length === 0 ? 200 : 503).json({
      status: reasons.length === 0 ? 'ready' : 'not_ready',
      service: opts.service,
      role: opts.role(),
      reasons,
    });
  });

  return router;
}
