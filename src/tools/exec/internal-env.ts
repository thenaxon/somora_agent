// somora-internal environment variables — the single list that `exec`
// and `tmux create` strip from agent-facing shells by default
// (`inherit_agent_env: false`), and that `tmux create` re-injects when
// the agent opts back in.
//
// Why a curated strip at all: the somora server (and the MCP tool
// child that claude-cli / codex-cli turns run through) carries state
// on its own process.env that is correct for somora and WRONG for a
// user project. hans, 2026-08-26: `npm run db:seed` failed in a
// Next.js project because the project's `tsx` honored somora's
// `TSX_TSCONFIG_PATH` and resolved `@/*` aliases against somora's
// tsconfig — half an hour lost hunting a project bug that wasn't one.
// `NODE_ENV=production` (from the systemd unit) silently reshaped
// `next dev`, dotenv and test-runner behavior in the same shell.
//
// What stays: SOMORA_AGENT / SOMORA_SESSION / SOMORA_ACTIVE_MODEL and
// the server address vars (SOMORA_HOST/PORT/HOME/TLS*) are the agent's
// identity and the way skill scripts call back into somora — they are
// not somora-*internal* in the sense meant here. NODE_OPTIONS is left
// alone too: somora never sets it, a user's profile might.

/** Exact names stripped. */
export const SOMORA_INTERNAL_ENV_NAMES: readonly string[] = [
  // claude-cli isolation (the original two — docs/setup.md, docs/tmux.md)
  'CLAUDE_CONFIG_DIR',
  'SOMORA_CLAUDE_BIN',
  // sibling engine-binary overrides and launcher plumbing
  'SOMORA_CODEX_BIN',
  'SOMORA_GROK_BIN',
  'SOMORA_BIN_PATH',
  'SOMORA_CODEX_SHELL_ENV_POLICY',
  // tsx exports this so nested tsx calls share ITS tsconfig; a user
  // project's tsx honors it and resolves path aliases against ours
  'TSX_TSCONFIG_PATH',
  // set on the server by the systemd unit; changes next/dotenv/vitest
  // behavior in any project shell that inherits it
  'NODE_ENV',
  // Claude Code marks its MCP children (our tool host) with these; a
  // project's build tools and postinstall scripts have no business
  // seeing the messaging token/socket of the agent that spawned them
  'CLAUDECODE',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'NoDefaultCurrentDirectoryInExePath',
];

/** Name prefixes stripped — the Claude Code messaging bridge uses a
 *  small family (TOKEN, SOCKET, …) that has grown before. Deliberately
 *  NOT the whole `CLAUDE_CODE_` prefix: `CLAUDE_CODE_OAUTH_TOKEN`,
 *  `CLAUDE_CODE_USE_BEDROCK` and friends are things a user sets on
 *  purpose in their login environment. */
export const SOMORA_INTERNAL_ENV_PREFIXES: readonly string[] = ['CLAUDE_CODE_MESSAGING_'];

export function isSomoraInternalEnv(name: string): boolean {
  if (SOMORA_INTERNAL_ENV_NAMES.includes(name)) return true;
  return SOMORA_INTERNAL_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/** Remove every somora-internal var from `env` in place; returns the
 *  names that were actually present (for logging). */
export function stripSomoraInternalEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (isSomoraInternalEnv(name)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

/** The somora-internal vars this process currently carries, with their
 *  values — what `tmux create { inherit_agent_env: true }` forwards
 *  explicitly via `-e`. */
export function somoraInternalEnvPresent(
  env: NodeJS.ProcessEnv = process.env,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isSomoraInternalEnv(name)) out.push([name, value]);
  }
  return out;
}

/** One-line summary for tool descriptions and docs. */
export const SOMORA_INTERNAL_ENV_SUMMARY =
  'CLAUDE_CONFIG_DIR, SOMORA_*_BIN, TSX_TSCONFIG_PATH, NODE_ENV, CLAUDECODE, ' +
  'CLAUDE_PROJECT_DIR, CLAUDE_CODE_ENTRYPOINT/SESSION_ID/MESSAGING_*';
