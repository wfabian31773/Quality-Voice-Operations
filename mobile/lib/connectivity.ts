type Listener = (online: boolean) => void;

let online = true;
const listeners = new Set<Listener>();

export function isOnline(): boolean {
  return online;
}

export function isOffline(): boolean {
  return !online;
}

export function markOnline(): void {
  if (online) return;
  online = true;
  for (const l of listeners) l(true);
}

export function markOffline(): void {
  if (!online) return;
  online = false;
  for (const l of listeners) l(false);
}

export function subscribeConnectivity(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
