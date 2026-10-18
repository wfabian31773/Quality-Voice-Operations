// Loader hooks for stress.ts: a busy box's loader thread. Every dynamic
// import() a runtime file (server/, platform/) makes waits `delayMs` of real
// time before it resolves. require() is untouched, so loading stays fast.
let delayMs = 0;

export function initialize(data) {
  delayMs = Number(data?.delayMs ?? 0);
}

export async function resolve(specifier, context, nextResolve) {
  const fromRuntime = /\/(server|platform)\//.test(context.parentURL ?? '');
  if (delayMs > 0 && fromRuntime && specifier.startsWith('.') && context.conditions?.includes('import')) {
    await new Promise((done) => setTimeout(done, delayMs));
  }
  return nextResolve(specifier, context);
}
