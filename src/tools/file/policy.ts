// Path policy for file_* tools — blacklist (not whitelist) since the
// user explicitly wants agents to be able to write outside the
// workspace (their own persona files, the global config, etc.).
//
// Two distinct rules apply:
//
//  - WRITE blacklist: paths the agent must never modify. Includes
//    system dirs (/etc, /usr, ...), credential stores (~/.ssh,
//    ~/.gnupg, ...), other agents' private state, and somora's own
//    internal session/index files. Realpath-resolved so symlink
//    escapes are caught.
//
//  - READ blacklist: smaller — only the things that should never be
//    fed to the model regardless of usefulness (private SSH keys,
//    /etc/shadow). Other paths are readable.
//
// Workspace resolution: relative paths resolve against the agent's
// workspace dir (per-agent override > config.workspace.default).
// Absolute paths pass through.

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import type { Config } from '../../config/types.ts';
import { loadPersona } from '../../persona/loader.ts';
import { effectiveWorkspace } from '../../server/workspace.ts';

const HOME = homedir();
const SOMORA_HOME = process.env.SOMORA_HOME ?? `${HOME}/.somora`;

// System paths blocked regardless of which user/home — absolute on any
// host, so they apply unchanged to local AND remote targets.
const SYSTEM_BLOCK = [
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/ssh',
  '/boot',
  '/sys',
  '/proc',
];

// Credential stores blocked relative to a user's home dir. Kept as
// home-relative suffixes so the same list resolves against the LOCAL
// home (ABSOLUTE_BLOCK below) or a REMOTE host's home
// (checkRemoteReadAllowed) — `~` differs per host.
const HOME_RELATIVE_BLOCK = ['.ssh', '.gnupg', '.aws/credentials', '.kube/config'];

// System paths and credential stores blocked for both read and write on
// the LOCAL host (somora server's own home).
const ABSOLUTE_BLOCK = [
  ...SYSTEM_BLOCK,
  ...HOME_RELATIVE_BLOCK.map((p) => `${HOME}/${p}`),
];

// Additional write-only blocks: system dirs that are reasonable to
// READ (some apps have config in /etc) but never to write.
const WRITE_ONLY_BLOCK = [
  '/etc',
  '/usr',
  '/boot',
  '/sys',
  '/proc',
  '/dev',
];

// somora's own internal state — agents must never touch these directly.
// Cross-agent persona/memory/agent.yaml IS writable (intentional —
// agents collaboratively edit each other in this design). What stays
// blocked is conversation history under any agent's sessions/, since
// that's append-only JSONL managed by the storage layer; tampering
// would corrupt cross-engine session-id meta and replay state.
const SOMORA_INTERNAL_BLOCK = [
  `${SOMORA_HOME}/known_hosts.json`, // SSH trust file
];

/**
 * Resolve a tool-input path into an absolute, realpath-checked path,
 * honouring the agent's workspace as the cwd for relative inputs.
 *
 * Returns null when the path is rejected by policy (with the reason).
 */
export interface ResolvedPath {
  absolute: string;
  workspace: string;
  /** True if the input path was relative (resolved against workspace). */
  wasRelative: boolean;
}

export async function resolveLocalPath(
  rawPath: string,
  agent: string,
  config: Config,
): Promise<ResolvedPath> {
  if (!rawPath || rawPath.trim().length === 0) {
    throw new Error('file path is empty');
  }
  const persona = await loadPersona(agent);
  if (!persona) throw new Error(`agent '${agent}' not found`);
  const workspace = effectiveWorkspace(persona, config);

  const expanded = expandHome(rawPath);
  const wasRelative = !isAbsolute(expanded);
  const absolute = wasRelative ? resolve(workspace, expanded) : normalize(expanded);

  return { absolute, workspace, wasRelative };
}

export function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return `${HOME}/${p.slice(2)}`;
  return p;
}

interface PolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Apply the read-blacklist. Always called for file_read.
 */
export function checkReadAllowed(absolute: string): PolicyResult {
  for (const blocked of ABSOLUTE_BLOCK) {
    if (isUnder(absolute, blocked)) {
      return { ok: false, reason: `read blocked: '${absolute}' is under '${blocked}'` };
    }
  }
  return { ok: true };
}

/**
 * Read-blacklist for a REMOTE host. Same protection as checkReadAllowed,
 * but the home-relative credential stores resolve against the REMOTE
 * user's home (passed in) since `~` differs per host; the system paths
 * are absolute and apply unchanged.
 *
 * Before the Juni-Audit 2026-06 fix, remoteRead/remoteList/remoteSearch
 * ran NO read policy at all — `file_read({path:"~/.ssh/id_ed25519",
 * target:"<resource>"})` fed a remote private key straight into model
 * context even though `exec cat ~/.ssh/...` is blacklisted. This closes
 * the local-vs-remote asymmetry.
 */
export function checkRemoteReadAllowed(absolute: string, remoteHome: string): PolicyResult {
  const home = remoteHome.replace(/\/+$/, '');
  const blocks = [
    ...SYSTEM_BLOCK,
    ...(home ? HOME_RELATIVE_BLOCK.map((p) => `${home}/${p}`) : []),
  ];
  for (const blocked of blocks) {
    if (isUnder(absolute, blocked)) {
      return {
        ok: false,
        reason: `read blocked: '${absolute}' is under '${blocked}' on the remote host`,
      };
    }
  }
  return { ok: true };
}

/**
 * Apply the write-blacklist. Always called for file_write/patch/delete.
 *
 * Cross-agent persona/memory/agent.yaml is intentionally writable —
 * agents are allowed to edit each other in this design. Only sessions/
 * dirs (any agent's) are blocked: those are append-only JSONL plus
 * meta files managed by the storage layer, and tampering corrupts
 * cross-engine session-id state.
 *
 * The `agent` param is unused for blacklist decisions today but kept
 * in the signature so future per-agent rules (e.g. "agent X can't
 * touch agent Y") have a place to land without churning callers.
 */
export function checkWriteAllowed(absolute: string, _agent: string): PolicyResult {
  for (const blocked of [...ABSOLUTE_BLOCK, ...WRITE_ONLY_BLOCK, ...SOMORA_INTERNAL_BLOCK]) {
    if (isUnder(absolute, blocked)) {
      return { ok: false, reason: `write blocked: '${absolute}' is under '${blocked}'` };
    }
  }
  // Block any agent's sessions/ dir — append-only JSONL conversation
  // history is managed by the storage layer; manual edits would
  // corrupt session-id meta and replay state.
  const agentsRoot = `${SOMORA_HOME}/agents`;
  if (isUnder(absolute, agentsRoot)) {
    const rel = absolute.slice(agentsRoot.length + 1).split(sep);
    if (rel.length >= 2 && rel[1] === 'sessions') {
      return {
        ok: false,
        reason: `write blocked: '${absolute}' is inside an agent's sessions/ dir (append-only conversation history, managed by the storage layer)`,
      };
    }
  }
  return { ok: true };
}

function isUnder(path: string, root: string): boolean {
  const p = normalize(path);
  const r = normalize(root);
  if (p === r) return true;
  return p.startsWith(r + sep);
}

/**
 * Realpath the closest existing ancestor of `absolute` and ensure
 * resolution can't escape via symlinks. For files that don't exist
 * yet (write-create), we walk up to find the nearest existing parent
 * and realpath that.
 */
export async function realpathSafeAncestor(absolute: string): Promise<string> {
  let probe = absolute;
  while (probe.length > 0 && probe !== sep) {
    try {
      return await realpath(probe);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return absolute;
}
