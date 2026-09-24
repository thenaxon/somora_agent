// Hard-blacklist for the `exec` tool. Match → block, no approval flow.
// Deliberately short list (~13 patterns) covering the actually
// dangerous things — destructive disk ops, privilege escalation, fork
// bombs, system halt, world-writable on system paths, obvious
// credential exfiltration. Iterative expansion when something new
// surfaces; we DON'T try to anticipate everything.
//
// Match-rule: regex tested against the command string after minimal
// normalization (trim + collapse internal whitespace). No AST/Tree-
// Sitter parsing — overkill for the threats we're actually defending
// against here. Anything sneaky enough to slip past these patterns
// can also slip past a much more elaborate parser; meanwhile a good
// agent has plenty of legitimate use for `chmod`, `rm` (with relative
// paths), `git`, `npm`, `make`, etc.
//
// Bypass surface (intentional): we only check the literal command
// string. A model that base64-encodes a malicious payload and pipes
// it through `bash` would slip past — but the `curl|sh` and `wget|sh`
// patterns catch the obvious remote-fetch case, and base64-pipe-bash
// is something a confused-but-non-adversarial model wouldn't do.
// somora's threat model is "don't accidentally `rm -rf /`," not
// "defend against a determined attacker who controls the LLM."

interface BlacklistEntry {
  pattern: RegExp;
  reason: string;
  /**
   * Test the pattern against each shell segment (split at `;`, `&&`,
   * `||`, `|`, background `&`, newlines) instead of the whole command
   * string. Lets a pattern anchor on COMMAND POSITION (`^…`) — the
   * halt/shutdown rule needs that so `echo "poweroff done"` (word in a
   * string argument) is not mistaken for `poweroff` (the command).
   */
  perSegment?: boolean;
  /**
   * A segment this matches is NOT a hit — the pattern's word appears
   * as an argument of a command that only looks things up. `command -v
   * sudo` / `which sudo` / `type sudo` ask where sudo is, they do not
   * run it (hans, 2026-09-24).
   */
  unless?: RegExp;
}

/**
 * Split a command line into the sub-commands the shell would run as
 * separate processes: at `;`, `&&`, `||`, `|` (pipe), background `&`,
 * and newlines — but NOT at redirect tokens (`2>&1`, `&>`, `>&`), which
 * stay within their segment.
 *
 * Pragmatic splitter, not a shell parser (same philosophy as the
 * patterns): quote-unaware, so `echo "a; b"` yields two segments. That
 * only ever makes us MORE conservative (more segments → more checks),
 * never less. Shared by the allowBlocked policy (./allowlist.ts) and
 * the per-segment blacklist entries below.
 */
export function splitCommandSegments(command: string): string[] {
  // Order matters: multi-char operators (&&, ||) must be alternatives
  // tried before their single-char counterparts. The background-`&`
  // branch uses look-around to skip `&` that is part of a redirect
  // (`2>&1`, `&>`, `&&` already consumed): not preceded by `>`/`&`/digit
  // and not followed by `>`/`&`.
  const SEP = /&&|\|\||;|\||\r?\n|(?<![>&\d])&(?![>&])/g;
  const parts = splitOutsideQuotes(command) ?? command.split(SEP);
  return parts.map((s) => stripSegmentWrapping(s.trim())).filter((s) => s.length > 0);
}

/**
 * Split at the shell operators, but not inside '…' or "…" — a `|` in
 * a grep pattern is not a pipe (`grep -E 'restart|reboot' RUNBOOK.md`
 * used to leave a segment `reboot` for the halt rule to trip on; hans,
 * 2026-09-24). A backslash escapes the next character outside single
 * quotes. Returns null when a quote is left open: then the old, purely
 * textual split applies — the stricter reading for a string whose
 * quoting we cannot follow.
 */
function splitOutsideQuotes(command: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        cur += command[++i]!;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += ch + command[++i]!;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    if (ch === '\r' && command[i + 1] === '\n') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '&') {
      // A lone `&` backgrounds; `2>&1`, `&>`, `>&` are redirects.
      const prev = command[i - 1] ?? '';
      const next = command[i + 1] ?? '';
      if (!/[>&\d]/.test(prev) && !/[>&]/.test(next)) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (quote) return null;
  out.push(cur);
  return out;
}

/**
 * Peel what wraps a segment's command without changing which command
 * runs: subshell/group openers and closers (`( … )`, `{ …; }`), a
 * leading `!`, and plain environment assignments in front (`LANG=C
 * sudo …`). Both the per-segment blacklist and the allowBlocked match
 * then see the same head — before 2026-09-24 the blacklist caught
 * `(sudo …` (its pattern allows `(` in front) while the allow-match
 * wanted the segment to START with `sudo`, so a granted sudo inside a
 * group was refused (hans). An assignment whose value carries `$(` or
 * a backtick is left alone: that is command substitution, which the
 * allow-match refuses on purpose (allowlist.ts).
 */
export function stripSegmentWrapping(segment: string): string {
  let s = segment;
  for (;;) {
    const before = s;
    s = s.replace(/^[({!\s]+/, '').replace(/[)}\s;]+$/, '');
    // Shell keywords that open a body: `for …; do sudo …; done` leaves
    // a segment `do sudo …`, `if sudo …; then` one `if sudo …`. The
    // command after the keyword is what runs (hans, 2026-09-24).
    s = s.replace(/^(?:do|then|else|elif|if|while|until)\s+/, '');
    const env = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^'`]*'|"[^"`$]*"|[^\s'"`$]*)(?:\s+|$)/;
    if (env.test(s)) s = s.replace(env, '');
    if (s === before) return s;
  }
}

// System halt/shutdown — matched on COMMAND POSITION only (per segment).
// The previous rule was a bare word search (`\b(shutdown|…)\b` over the
// whole text) and blocked every string that merely mentioned the word:
// `echo "poweroff issued"`, `cat poweroff.log`, `# reboot later`. On a
// host whose allowBlocked list permits `systemctl poweroff`, the
// shutdown itself passed while the status echo next to it was blocked
// (hans's report 2026-09-03). Now the word must be the command the
// shell would run: first token of the segment, optionally behind a
// subshell paren, leading `VAR=x` assignments, and wrapper commands
// (`sudo -n`, `doas`, `env`, `nice`, `nohup`, `time`, `ionice`,
// `command`, `exec`), or the verb right after `systemctl`.
// `bash -c "shutdown"` slips past — same class as the base64 bypass
// the header accepts.
const HALT_WRAPPERS = '(?:sudo|doas|env|nice|nohup|time|ionice|command|exec)';
const HALT_COMMAND_PATTERN = new RegExp(
  String.raw`^[({]?\s*` +
    // leading VAR=value assignments
    String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*` +
    // wrapper commands with their flags
    String.raw`(?:${HALT_WRAPPERS}\s+(?:-\S+\s+)*)*` +
    // systemctl <verb>
    String.raw`(?:systemctl\s+(?:-\S+\s+)*)?` +
    String.raw`(shutdown|halt|reboot|poweroff)\b(?!\s+-h\s+now\s+--help)`,
);

// `rm -rf <path>` matcher. We block ONLY when <path> is a system
// directory; user-owned dirs (/Users/<u>, /home/<u>, /tmp,
// /var/folders) pass through. the user's bug 2026-05-06: the previous
// pattern /\/[a-zA-Z]/ blocked every absolute path under /, forcing
// workarounds like `cd ~ && rm -rf foo`. somora's threat model is
// "don't accidentally `rm -rf /` or wipe /etc", not "no destructive
// ops anywhere".
//
// Two patterns rather than one, because path-segment alternation
// inside an `\s+` boundary is hard to read. Both must be tried; the
// flag order rule (-rf vs -fr) is captured by the [a-zA-Z]* fillers
// in each. Trailing alternation: `(\/|\s|$|;|&|\|)` — the system dir
// must be terminated by another path separator or shell separator,
// so we don't false-match `rm -rf /etcetera` (legit user dir named
// "etcetera" under /).
const RM_RF_FLAGS = '(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)';
const SYSTEM_DIRS =
  '(?:bin|sbin|usr|etc|lib|lib32|lib64|sys|proc|boot|dev|root|opt|var\\/log|var\\/lib|var\\/spool|var\\/run|Library|System|Applications|private|Network|Volumes)';
const RM_RF_SYSTEM_PATTERN = new RegExp(
  // rm -rf on `/` exactly (delete root) or rm -rf on a system dir
  String.raw`\brm\s+` +
    RM_RF_FLAGS +
    String.raw`\s+(?:` +
    // case A: bare /
    String.raw`\/(?:\s|$|;|&|\|)|` +
    // case B: /<system>/...
    String.raw`\/${SYSTEM_DIRS}(?:\/|\s|$|;|&|\|)` +
    String.raw`)`,
);

const HARD_BLACKLIST: ReadonlyArray<BlacklistEntry> = [
  // ── Destructive disk operations ──
  { pattern: RM_RF_SYSTEM_PATTERN, reason: 'rm -rf on system path' },
  { pattern: /\bdd\s+[^|;&]*\bif=/, reason: 'dd if= (raw disk-image write)' },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: 'mkfs (format filesystem)' },
  { pattern: /\bshred\s+-/, reason: 'shred (overwrite + delete)' },

  // ── Privilege escalation ──
  // Backtick in the boundary: `X=\`sudo id\`` runs sudo in a substitution
  // and used to slip past (2026-09-24).
  {
    pattern: /(^|[\s|;&(`])sudo(\s|$)/,
    reason: 'sudo (privilege escalation)',
    perSegment: true,
    unless: /^(?:command\s+-[vV]|which|type|whereis|hash)\s/,
  },
  { pattern: /(^|[\s|;&(])doas(\s|$)/, reason: 'doas (privilege escalation)' },
  { pattern: /(^|[\s|;&(])su(\s+-?\s*$|\s+-)/, reason: 'su (switch user)' },

  // ── Fork bombs + system halt ──
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, reason: 'classic fork bomb' },
  { pattern: HALT_COMMAND_PATTERN, reason: 'system halt/shutdown', perSegment: true },

  // ── World-writable on system paths ──
  {
    pattern: /\bchmod\s+(-[^\s]*\s+)*(777|666|a\+w)\s+\/(etc|usr|bin|sbin|boot|root|var|opt)\b/,
    reason: 'chmod world-writable on system path',
  },

  // ── Obvious credential exfiltration ──
  { pattern: /\bcat\s+[^|;&]*\.ssh\/id_(rsa|ed25519|ecdsa|dsa)(?!\.pub)\b/, reason: 'reading private SSH key' },

  // ── Untrusted remote-fetch + execute ──
  { pattern: /\bcurl\s+[^|]*\|\s*(bash|sh|zsh|ksh|dash)\b/, reason: 'curl | sh (untrusted remote exec)' },
  { pattern: /\bwget\s+[^|]*-O-\s*[^|]*\|\s*(bash|sh|zsh|ksh|dash)\b/, reason: 'wget | sh (untrusted remote exec)' },
  { pattern: /\bwget\s+[^|]*-qO-\s*[^|]*\|\s*(bash|sh|zsh|ksh|dash)\b/, reason: 'wget | sh (untrusted remote exec)' },
];

export interface BlacklistMatch {
  matched: true;
  reason: string;
  /** The pattern that matched, as string (for debugging / logs). */
  pattern: string;
}

export interface BlacklistOk {
  matched: false;
}

export type BlacklistCheck = BlacklistMatch | BlacklistOk;

/**
 * Test a command string against the hard-blacklist. Returns
 * `{matched: true, reason, pattern}` for the first match, else
 * `{matched: false}`. Caller refuses execution + surfaces the reason
 * to the model so it can adapt.
 *
 * Whitespace is normalized (trim + collapse runs to single space)
 * before matching so the model can't dodge a pattern with extra
 * spaces. Comments / leading variables (`X=1 sudo …`) still slip
 * past the simple anchor rules — that's OK for our threat model.
 */
export function checkBlacklist(command: string): BlacklistCheck {
  const normalized = normalize(command);
  const segments = splitCommandSegments(command).map(normalize);
  for (const entry of HARD_BLACKLIST) {
    if (entryMatches(entry, normalized, segments)) {
      return {
        matched: true,
        reason: entry.reason,
        pattern: entry.pattern.source,
      };
    }
  }
  return { matched: false };
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Whole-text entries test the normalized command; per-segment entries
 * test every shell segment on its own. Segments are split BEFORE
 * whitespace normalization so a newline still separates commands —
 * otherwise `echo hi\nshutdown -h now` would collapse into one line
 * and the command-position anchor would never see `shutdown`.
 */
function entryMatches(entry: BlacklistEntry, normalized: string, segments: string[]): boolean {
  if (entry.perSegment) return segments.some((seg) => !entry.unless?.test(seg) && entry.pattern.test(seg));
  return entry.pattern.test(normalized);
}

/**
 * Return the reasons of ALL blacklist patterns that match the command
 * (not just the first, as `checkBlacklist` does). Needed by the
 * segment-aware exec policy: a command can trip several patterns at
 * once (e.g. `sudo … curl … | sh` matches both `sudo` and `curl|sh`),
 * and the policy must know about every one to decide which are
 * cross-segment (un-overridable) dangers. Same normalization as
 * checkBlacklist.
 */
export function blacklistReasons(command: string): string[] {
  const normalized = normalize(command);
  const segments = splitCommandSegments(command).map(normalize);
  const out: string[] = [];
  for (const entry of HARD_BLACKLIST) {
    if (entryMatches(entry, normalized, segments)) out.push(entry.reason);
  }
  return out;
}

/**
 * Surface the full blacklist for diagnostic / debugging tools (so a
 * developer can ask "what's currently blocked?" via a tool or log).
 * Read-only.
 */
export function listBlacklist(): ReadonlyArray<{ pattern: string; reason: string }> {
  return HARD_BLACKLIST.map((e) => ({ pattern: e.pattern.source, reason: e.reason }));
}
