// How an external agent's system is named and shown (docs/external-agents.md):
// the label (OpenClaw, Hermes, or what the agent calls itself), the sign
// in the tile corner, and the version once connected. Used by the agent
// list, the session list and the team block.

import { extname } from 'node:path';
import { initialsBadge, profileByName, profileFromCommand } from '../acp/profiles.ts';
import { knownInfo } from './connection.ts';
import type { ExternalAgent } from './registry.ts';

export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

/** A badge setting that names an image file, not a sign. */
export function badgeIsImage(badge: string | undefined): boolean {
  return !!badge && /[\\/]/.test(badge) && !!IMAGE_TYPES[extname(badge).toLowerCase()];
}

/** How a client shows where an external agent comes from. */
export function externalBadge(ext: ExternalAgent): { label: string; badge: string; badgeImage: string | null; version: string | null } {
  const info = knownInfo(ext.name);
  const profile = ext.systemConfig.profile ? profileByName(ext.systemConfig.profile) : info?.profile ?? profileFromCommand(ext.agent.command);
  const label = profile && profile.name !== 'generic' ? profile.label : (info?.agentInfo?.title || info?.agentInfo?.name || ext.system);
  const set = ext.systemConfig.badge;
  const image = badgeIsImage(set) ? `/external/${encodeURIComponent(ext.system)}/badge` : null;
  const badge = !image && set ? set : profile?.badge ?? initialsBadge(String(label));
  return { label: String(label), badge, badgeImage: image, version: info?.agentInfo?.version ?? null };
}

