// Per-agent color resolver shared by AvatarRow + ChatArea (peer-agent
// bubbles need the SENDER's color, not the active agent's). Mirrors
// web/src/lib/colors.ts so an agent gets the same fallback color on
// both clients when AGENTS.md doesn't specify one.

const PALETTE = [
  '#5cf2d6',
  '#9d8cff',
  '#f5b942',
  '#ff6b9d',
  '#7fff95',
  '#69b6ff',
];

export function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

export function resolveAgentColor(agent: { name: string; color?: string }): string {
  return agent.color ?? colorFor(agent.name);
}
