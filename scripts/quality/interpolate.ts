/**
 * Replace `{{var}}` placeholders in script steps from the last tool results.
 */
export function interpolate(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{{${key}}}`,
    );
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, vars));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(nested, vars);
    }
    return out;
  }
  return value;
}

export function captureVars(result: {
  ok: boolean;
  data?: unknown;
  readback?: string;
  error?: { callerSafeMessage?: string };
}): Record<string, string> {
  const vars: Record<string, string> = {};
  if (result.readback) vars.readback = result.readback;
  if (!result.ok && result.error?.callerSafeMessage) {
    vars.callerSafeMessage = result.error.callerSafeMessage;
  }
  if (result.ok && result.data && typeof result.data === 'object') {
    for (const [key, value] of Object.entries(result.data as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') vars[key] = String(value);
    }
  }
  return vars;
}
