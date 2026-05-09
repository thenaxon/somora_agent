// Deterministic per-agent color fallback. Used when the server's
// /agents response doesn't include a `color` field (older somora
// versions). Same name → same color across reloads. Six-color
// palette so visually-distinct agents stay distinct in the dock + on
// window borders.

const PALETTE = [
  '#5cf2d6', // cyan-teal (matches the somora accent — first agent)
  '#9d8cff', // violet
  '#f5b942', // amber
  '#ff6b9d', // rose
  '#7fff95', // mint
  '#69b6ff', // sky
];

export function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/** Build the agent-icon-glyph linear-gradient — replicates the
 *  click-dummy's `accent` field which was a hardcoded 135deg from
 *  the agent color into a darker variant. We compute the darker side
 *  by interpolating to ~50% black. */
export function gradientFor(color: string): string {
  return `linear-gradient(135deg, ${color}, ${darken(color, 0.5)})`;
}

/** Hex → darker hex by mixing toward black. `amount` 0..1 = full
 *  black. Naive RGB lerp; good enough for visual gradients. */
function darken(hex: string, amount: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const f = (v: number) => Math.round(v * (1 - amount));
  const out = (f(r) << 16) | (f(g) << 8) | f(b);
  return '#' + out.toString(16).padStart(6, '0');
}

export function resolveAgentColor(agent: { name: string; color?: string }): string {
  return agent.color ?? colorFor(agent.name);
}
