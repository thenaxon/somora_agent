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
}

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
  { pattern: /(^|[\s|;&(])sudo(\s|$)/, reason: 'sudo (privilege escalation)' },
  { pattern: /(^|[\s|;&(])doas(\s|$)/, reason: 'doas (privilege escalation)' },
  { pattern: /(^|[\s|;&(])su(\s+-?\s*$|\s+-)/, reason: 'su (switch user)' },

  // ── Fork bombs + system halt ──
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, reason: 'classic fork bomb' },
  { pattern: /\b(shutdown|halt|reboot|poweroff)\b(?!\s+-h\s+now\s+--help)/, reason: 'system halt/shutdown' },

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
  const normalized = command.trim().replace(/\s+/g, ' ');
  for (const entry of HARD_BLACKLIST) {
    if (entry.pattern.test(normalized)) {
      return {
        matched: true,
        reason: entry.reason,
        pattern: entry.pattern.source,
      };
    }
  }
  return { matched: false };
}

/**
 * Surface the full blacklist for diagnostic / debugging tools (so a
 * developer can ask "what's currently blocked?" via a tool or log).
 * Read-only.
 */
export function listBlacklist(): ReadonlyArray<{ pattern: string; reason: string }> {
  return HARD_BLACKLIST.map((e) => ({ pattern: e.pattern.source, reason: e.reason }));
}
