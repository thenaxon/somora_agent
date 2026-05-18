// Per-resource privileged-command allowlist for the exec tool.
//
// The global blacklist (./blacklist.ts) is the safe default — it
// refuses sudo/reboot/shutdown/etc globally so a misbehaving agent
// can't break a host by accident. Some resources, though, are
// dedicated agent-workstations where Somora-agents are SUPPOSED to
// run admin commands (system updates, kernel reboots, mount fixes).
// For those, the resource's config opts in to a list of commands
// that may run despite a blacklist match.
//
// This file holds the match-check and the audit-log writer. Wiring
// into the exec flow lives in ./tools.ts.

import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const AUDIT_DIR = join(SOMORA_HOME, 'audit');
const AUDIT_PATH = join(AUDIT_DIR, 'exec-privileged.jsonl');

/**
 * Normalize a command string the same way blacklist matching does:
 * trim ends + collapse internal whitespace to single spaces. Keeps
 * allowlist entries and the runtime command string comparable.
 */
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

export interface AllowBlockedMatch {
  /** The entry (post-normalize) that matched. */
  entry: string;
}

/**
 * Check whether the command matches any allowBlocked entry.
 *
 * Match rule (one rule, intentionally simple):
 *   entry E matches command C iff
 *     normalize(C) === normalize(E)         (exact)
 *     OR
 *     normalize(C).startsWith(normalize(E) + ' ')   (prefix with space boundary)
 *
 * The space-boundary stops `sudo` from matching `pseudo` and
 * `systemctl reboot` from matching `systemctl rebootthing`.
 *
 * Returns the matched entry on hit, or null. First match wins —
 * order in config.yaml is irrelevant since matching is OR.
 */
export function checkAllowBlocked(
  command: string,
  entries: ReadonlyArray<string>,
): AllowBlockedMatch | null {
  if (entries.length === 0) return null;
  const c = normalize(command);
  for (const raw of entries) {
    const e = normalize(raw);
    if (e.length === 0) continue;
    if (c === e || c.startsWith(e + ' ')) {
      return { entry: e };
    }
  }
  return null;
}

export interface AuditEntry {
  ts: number;
  agent: string;
  session: string;
  resource: string;
  /** First 200 chars of the command — full string lives only here. */
  command_head: string;
  matched_entry: string;
  blacklist_reason: string;
  blacklist_pattern: string;
  /** Set when the command finishes; absent if we only log the auth step. */
  exit_code?: number | null;
  ms?: number;
}

/**
 * Append a single JSONL line to ~/.somora/audit/exec-privileged.jsonl.
 *
 * Best-effort: any I/O error is swallowed (and logged via the standard
 * logger by the caller if wanted) — audit logging must NOT block the
 * actual command from running, and must not throw inside the exec
 * handler. The audit log exists for after-the-fact review.
 */
export async function auditPrivilegedExec(entry: AuditEntry): Promise<void> {
  try {
    if (!existsSync(AUDIT_DIR)) {
      await mkdir(AUDIT_DIR, { recursive: true });
    }
    const line = JSON.stringify(entry) + '\n';
    await appendFile(AUDIT_PATH, line, 'utf8');
  } catch {
    // Intentional swallow — see comment above. The caller has the
    // option to also logger.warn() if it cares about the failure.
  }
}

export const AUDIT_LOG_PATH = AUDIT_PATH;
