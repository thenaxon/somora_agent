// What differs between ACP agents (private/external-agents/KONZEPT.md,
// "System-Profile"). ACP is one language, but each system speaks it a
// little differently; the general translator does the common part, a
// profile holds the rest. Chosen from the agent's own introduction
// (`initialize` → agentInfo.name), or set in config.yaml.
//
// A system without a profile runs on `generic`. A profile is added when
// a system shows something worth handling.

export type ProfileName = 'openclaw' | 'hermes' | 'generic';

export interface AcpProfile {
  name: ProfileName;
  /** Shown on the agent tile and in the chat header. */
  label: string;
  /** The sign the project uses for itself (a Unicode character, not a
   *  logo) — the default badge in the tile corner. */
  badge?: string;
  /** Sessions in `session/list` that are not conversations (schedules,
   *  automations) — left out wherever sessions are offered. */
  hideSession?: (s: { sessionId: string; title?: string | null; _meta?: unknown }) => boolean;
  /** The reply arrives as one block, not word by word: the chat shows it
   *  without a typing animation. */
  replyInOneBlock?: boolean;
}

const PROFILES: Record<ProfileName, AcpProfile> = {
  openclaw: {
    name: 'openclaw',
    label: 'OpenClaw',
    badge: '🦞',
    replyInOneBlock: true,
    hideSession: (s) => {
      const key = String((s._meta as { sessionKey?: unknown } | undefined)?.sessionKey ?? s.sessionId);
      return /:(cron|subagent|acp-bridge):/.test(key) || key.startsWith('acp-bridge:');
    },
  },
  hermes: {
    name: 'hermes',
    label: 'Hermes',
    badge: '☤',
  },
  generic: {
    name: 'generic',
    label: 'External',
  },
};

/** The profile for an agent's self-introduction. */
export function profileFor(agentInfo: { name?: string | null; title?: string | null } | null | undefined): AcpProfile {
  const id = `${agentInfo?.name ?? ''} ${agentInfo?.title ?? ''}`.toLowerCase();
  if (id.includes('openclaw')) return PROFILES.openclaw;
  if (id.includes('hermes')) return PROFILES.hermes;
  return { ...PROFILES.generic, ...(agentInfo?.title || agentInfo?.name ? { label: String(agentInfo.title || agentInfo.name) } : {}) };
}

export function profileByName(name: ProfileName): AcpProfile {
  return PROFILES[name];
}

/** The neutral badge for a system without a sign of its own: its
 *  initials, at most two letters ("OpenClaw ACP Gateway" → "OA"). */
export function initialsBadge(label: string): string {
  const words = label.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
