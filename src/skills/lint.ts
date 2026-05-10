// Skill body linter. Runs over the markdown body (frontmatter already
// stripped) at load time and refuses to expose anti-pattern skills to
// the agent.
//
// Why this exists: SKILL.md bodies are loaded verbatim into the agent's
// context whenever `skill({name})` is called. Anything written like an
// instruction is followed like an instruction — including
// "set this env var" / "prepend `eval $(brew shellenv)` to your call".
// The 2026-05-10 gog regression was exactly this: a 17-line
// "Setup on this host" section in the body told the agent to inject
// env vars per-call, even though the somora server already provides
// them. The agent dutifully complied on every turn.
//
// What we do NOT do: rewrite the body, strip sections, or paper over
// the issue. Skill authors keep full control of their content; the
// linter only flags bodies that are likely to mislead the model and
// either warns (soft) or refuses to expose the skill (hard) so the
// author has to clean it up before agents can rely on it.
//
// Conventions referenced (see ~/.somora/skills/<name>/BOOTSTRAP.md):
//   - Setup/install steps live in BOOTSTRAP.md, not SKILL.md.
//   - Env vars are declared in metadata.somora.requires.env_vars and
//     loaded from ~/.somora/somora.env (or systemd EnvironmentFile=).
//   - SKILL.md body documents *usage*, not *bootstrap*.

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
  severity: LintSeverity;
  /** 1-based line number in the body. 0 = body-wide finding. */
  line: number;
  /** Short stable identifier so the message survives wording changes. */
  rule: string;
  /** The snippet (or '<body>' for body-wide findings). */
  excerpt: string;
  /** Human explanation of why this is a problem and how to fix it. */
  message: string;
}

interface LineRule {
  rule: string;
  pattern: RegExp;
  severity: LintSeverity;
  message: string;
  /** When true, only match inside fenced code blocks (```...```). Inline
   *  code in prose (single backticks) and plain prose are exempted —
   *  those are typically documentation referring to a pattern, often
   *  in a "do NOT do X" sentence. We want to flag examples the model
   *  might copy, which live in fenced blocks. */
  codeBlocksOnly: boolean;
  /** When true, only match outside fenced code blocks. Section headers
   *  are not valid inside code, so we anchor them in prose. */
  proseOnly?: boolean;
}

const LINE_RULES: LineRule[] = [
  {
    rule: 'setup-section-in-body',
    pattern: /^##+\s+Setup(\s+(on\s+this\s+host|here|.+))?\s*$/i,
    severity: 'error',
    codeBlocksOnly: false,
    proseOnly: true,
    message:
      'Setup/install instructions belong in a BOOTSTRAP.md file (operator-only, not loaded into agent context). The SKILL.md body is read verbatim into every agent turn that activates this skill — anything that reads as a per-call instruction will be followed per call. If the section is genuinely a one-time bootstrap note, move it to BOOTSTRAP.md and replace it with a short ## Preconditions block.',
  },
  {
    rule: 'eval-brew-shellenv-in-body',
    pattern: /\beval\s+["']?\$\([^)]*brew\s+shellenv/,
    severity: 'error',
    codeBlocksOnly: true,
    message:
      'Do not embed `eval $(brew shellenv)` in a code block. The agent treats fenced code as runnable examples and will reflexively prepend it to every command. PATH for skill binaries belongs in the somora launch environment (systemd EnvironmentFile, ~/.somora/somora.env, launchd plist) — fix it there once for every agent.',
  },
  {
    rule: 'export-env-in-body',
    pattern: /^\s*export\s+[A-Z][A-Z0-9_]*=/,
    severity: 'error',
    codeBlocksOnly: true,
    message:
      'Do not export env vars in a code block. Declare them in metadata.somora.requires.env_vars and set them in ~/.somora/somora.env or the systemd unit. The skill loader checks env_vars at load time and refuses unavailable skills with a clear reason — that path is preferred over per-call injection.',
  },
  {
    rule: 'env-prefix-cmd-in-body',
    pattern: /^\s*[A-Z][A-Z0-9_]*=['"]?[^=\s]+['"]?\s+[a-z][a-z0-9_-]*\s/,
    severity: 'warning',
    codeBlocksOnly: true,
    message:
      'Inline `KEY=value command ...` snippets in code blocks train the agent to set env per call. Prefer bare command examples plus a `## Preconditions` block listing the required env_vars at the top of the body.',
  },
];

/** Pre-compute which lines are inside fenced code blocks (```...```).
 *  Returns a boolean array, same length as lines, true if line i is
 *  inside a fenced block. Fence lines themselves are NOT considered
 *  inside (so a rule on a fence boundary is treated as prose). */
function computeFenceMap(lines: string[]): boolean[] {
  const fenceMap = new Array<boolean>(lines.length).fill(false);
  let inside = false;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    if (/^\s*```/.test(text)) {
      inside = !inside;
      // Fence line itself: prose, not code.
      fenceMap[i] = false;
      continue;
    }
    fenceMap[i] = inside;
  }
  return fenceMap;
}

interface BodyRule {
  rule: string;
  severity: LintSeverity;
  test: (body: string) => string | null;
  message: string;
}

const BODY_RULES: BodyRule[] = [
  {
    rule: 'body-too-large',
    severity: 'warning',
    test: (body: string) => {
      const lines = body.split('\n').length;
      return lines > 200 ? `${lines} lines` : null;
    },
    message:
      'Skill body is large; the whole thing lands in the agent context on every activation. Consider splitting reference material out (BOOTSTRAP.md for operators, REFERENCE.md not loaded into context) and keeping SKILL.md as a tight usage cheatsheet.',
  },
];

export function lintSkillBody(body: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = body.split('\n');
  const fenceMap = computeFenceMap(lines);
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    const insideFence = fenceMap[i] ?? false;
    for (const rule of LINE_RULES) {
      if (rule.codeBlocksOnly && !insideFence) continue;
      if (rule.proseOnly && insideFence) continue;
      if (rule.pattern.test(text)) {
        findings.push({
          severity: rule.severity,
          line: i + 1,
          rule: rule.rule,
          excerpt: text.trim().slice(0, 160),
          message: rule.message,
        });
      }
    }
  }
  for (const rule of BODY_RULES) {
    const detail = rule.test(body);
    if (detail !== null) {
      findings.push({
        severity: rule.severity,
        line: 0,
        rule: rule.rule,
        excerpt: `<body: ${detail}>`,
        message: rule.message,
      });
    }
  }
  return findings;
}

export function summarizeFindings(findings: LintFinding[]): {
  errorCount: number;
  warningCount: number;
  shortReason: string;
} {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const shortReason =
    errors.length > 0
      ? errors
          .slice(0, 3)
          .map((e) => `${e.rule}@L${e.line}`)
          .join(', ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : '')
      : '';
  return { errorCount: errors.length, warningCount: warnings.length, shortReason };
}
