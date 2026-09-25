/** Merge options over defaults, ignoring keys explicitly set to `undefined`. */
export function withDefaults<D extends object, O extends object>(defaults: D, options: O): D & O {
  const out = { ...defaults } as Record<string, unknown>;
  for (const [k, v] of Object.entries(options)) if (v !== undefined) out[k] = v;
  return out as D & O;
}
