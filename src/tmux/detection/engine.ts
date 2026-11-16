// State detection for coding agents in a terminal, after herdr's
// agent-detection manifests (manifests/, Apache-2.0, see SOURCE.json).
// A port of herdr's evaluator (src/detect/manifest.rs): the same rule
// format, regions and precedence, so herdr's rules work unchanged.
//
// Pure: no tmux, no files. manifests.ts loads the rules; callers pass the
// screen (the visible rows, trailing blank rows dropped — what herdr
// reads) and the pane title.
//
// How a manifest decides: every rule is tried against its region of the
// screen. Of the rules that match, the highest priority wins; on a tie
// the earlier rule. No rule matches → a known agent is `idle` (herdr's
// default_known_agent_idle_fallback).

export type AgentState = 'idle' | 'working' | 'blocked' | 'unknown';

/** A condition: every listed matcher must hold. */
export interface ManifestGate {
  /** Case-insensitive substrings, all present. */
  contains?: string[];
  /** Patterns that must all match the region. */
  regex?: string[];
  /** Patterns that must each match some line of the region. */
  line_regex?: string[];
  all?: ManifestGate[];
  /** At least one, when given. */
  any?: ManifestGate[];
  /** None may match. */
  not?: ManifestGate[];
}

export interface ManifestRule extends ManifestGate {
  id: string;
  state?: AgentState;
  priority?: number;
  /** Default `whole_recent`. */
  region?: string;
  visible_idle?: boolean;
  visible_blocker?: boolean;
  visible_working?: boolean;
  /** A screen that says nothing about the state (a transcript viewer):
   *  keep the previous state. */
  skip_state_update?: boolean;
}

export interface AgentManifest {
  id: string;
  version?: string;
  min_engine_version?: number;
  updated_at?: string;
  aliases?: string[];
  rules: ManifestRule[];
}

export interface DetectionInput {
  /** Visible rows of the pane, trailing blank rows dropped. */
  screen: string;
  /** The pane title (OSC 0/2), as tmux reports it in #{pane_title}. */
  title?: string;
  /** OSC 9;4 progress — tmux does not keep it, so normally empty. */
  progress?: string;
}

export interface Detection {
  state: AgentState;
  /** The matched rule; absent on the idle fallback. */
  rule?: { id: string; priority: number; region: string };
  skipStateUpdate: boolean;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  /** `default_known_agent_idle_fallback` when no rule matched. */
  fallback?: string;
}

export interface RuleEvaluation {
  id: string;
  state: AgentState;
  priority: number;
  region: string;
  matched: boolean;
  /** The start of the region text the rule saw. */
  regionPreview: string;
}

/** The regions and matchers this port implements (herdr engine 3). */
export const ENGINE_VERSION = 3;

// ─── Rust regex → JavaScript ────────────────────────────────────────

/** Translate a Rust `regex` pattern to a JavaScript RegExp (unicode
 *  mode). Covers what herdr's manifests use: leading inline flags
 *  `(?ims)`, `\x{…}`, `\A`, `\z`, `\p{…}`. Throws on what it cannot
 *  translate faithfully. */
export function rustRegex(pattern: string): RegExp {
  let src = pattern;
  let flags = 'u';
  const lead = /^\(\?([a-zA-Z]+)\)/.exec(src);
  if (lead) {
    for (const f of lead[1]!) {
      if (f === 'i' || f === 'm' || f === 's') {
        if (!flags.includes(f)) flags += f;
      } else {
        throw new Error(`inline flag "${f}" is not supported`);
      }
    }
    src = src.slice(lead[0].length);
  }
  if (/\(\?[a-zA-Z]+[):]/.test(src)) throw new Error('inline flags inside the pattern are not supported');
  if (/\\[QEhHKG]/.test(src)) throw new Error('escape not supported in JavaScript');
  // Walk the pattern so escapes are rewritten only where they are escapes.
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = src[i + 1];
    if (next === 'x' && src[i + 2] === '{') {
      const end = src.indexOf('}', i + 3);
      if (end < 0) throw new Error('unterminated \\x{');
      out += `\\u{${src.slice(i + 3, end)}}`;
      i = end;
    } else if (next === 'z') {
      out += '(?![\\s\\S])';
      i += 1;
    } else if (next === 'A') {
      out += '(?<![\\s\\S])';
      i += 1;
    } else {
      out += ch + (next ?? '');
      i += 1;
    }
  }
  return new RegExp(out, flags);
}

// ─── compiling ──────────────────────────────────────────────────────

interface CompiledGate {
  contains: string[];
  regex: RegExp[];
  lineRegex: RegExp[];
  all: CompiledGate[];
  any: CompiledGate[];
  not: CompiledGate[];
}

export interface CompiledManifest {
  manifest: AgentManifest;
  rules: Array<{ rule: ManifestRule; gate: CompiledGate }>;
}

const KNOWN_REGIONS = new Set([
  'whole_recent',
  'after_last_prompt_marker',
  'before_current_prompt_marker',
  'whole_recent_without_current_prompt_marker',
  'current_prompt_block_marker',
  'after_current_prompt_block_marker',
  'prompt_box_body',
  'above_prompt_box',
  'last_non_empty_above_prompt_box',
  'after_last_horizontal_rule',
  'osc_title',
  'osc_progress',
]);
const COUNTED_REGION = /^(bottom_lines|bottom_non_empty_lines|top_non_empty_lines)\(([1-9]\d{0,4})\)$/;

function compileGate(gate: ManifestGate, where: string): CompiledGate {
  const compile = (list: string[] | undefined, field: string) =>
    (list ?? []).map((p, i) => {
      try {
        return rustRegex(p);
      } catch (err) {
        throw new Error(`${where}: ${field}[${i}] ${(err as Error).message}: ${p}`);
      }
    });
  return {
    contains: (gate.contains ?? []).map((s) => s.toLowerCase()),
    regex: compile(gate.regex, 'regex'),
    lineRegex: compile(gate.line_regex, 'line_regex'),
    all: (gate.all ?? []).map((g, i) => compileGate(g, `${where}.all[${i}]`)),
    any: (gate.any ?? []).map((g, i) => compileGate(g, `${where}.any[${i}]`)),
    not: (gate.not ?? []).map((g, i) => compileGate(g, `${where}.not[${i}]`)),
  };
}

/** Check and compile a manifest. Throws with the rule and field on
 *  anything this engine cannot evaluate as herdr would. */
export function compileManifest(manifest: AgentManifest): CompiledManifest {
  if (!manifest || typeof manifest.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(manifest.id)) {
    throw new Error('manifest needs an id ([a-z][a-z0-9_-]*)');
  }
  if (!Array.isArray(manifest.rules)) throw new Error(`${manifest.id}: rules must be a list`);
  if ((manifest.min_engine_version ?? 1) > ENGINE_VERSION) {
    throw new Error(`${manifest.id}: needs engine ${manifest.min_engine_version}, this one is ${ENGINE_VERSION}`);
  }
  const ids = new Set<string>();
  const rules = manifest.rules.map((rule, i) => {
    const where = `${manifest.id} rule ${rule?.id ?? i}`;
    if (!rule || typeof rule.id !== 'string' || !rule.id) throw new Error(`${manifest.id}: rule ${i} has no id`);
    if (ids.has(rule.id)) throw new Error(`${where}: duplicate id`);
    ids.add(rule.id);
    if (rule.state !== undefined && !['idle', 'working', 'blocked', 'unknown'].includes(rule.state)) {
      throw new Error(`${where}: unknown state "${rule.state}"`);
    }
    const region = (rule.region ?? 'whole_recent').trim();
    if (!KNOWN_REGIONS.has(region) && !COUNTED_REGION.test(region)) throw new Error(`${where}: unknown region "${region}"`);
    const gate = compileGate(rule, where);
    if (!hasMatcher(gate)) throw new Error(`${where}: no matcher`);
    return { rule, gate };
  });
  return { manifest, rules };
}

function hasMatcher(g: CompiledGate): boolean {
  return g.contains.length > 0 || g.regex.length > 0 || g.lineRegex.length > 0 || g.all.some(hasMatcher) || g.any.some(hasMatcher);
}

// ─── matching ───────────────────────────────────────────────────────

/** Rust's str::lines: split on \n, drop one trailing \r per line, no
 *  empty last line for a trailing \n. */
function rustLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function gateMatches(g: CompiledGate, text: string, lower: string): boolean {
  if (!g.contains.every((n) => lower.includes(n))) return false;
  if (!g.regex.every((r) => r.test(text))) return false;
  if (g.lineRegex.length > 0) {
    const lines = rustLines(text);
    if (!g.lineRegex.every((r) => lines.some((l) => r.test(l)))) return false;
  }
  if (!g.all.every((n) => gateMatches(n, text, lower))) return false;
  if (g.any.length > 0 && !g.any.some((n) => gateMatches(n, text, lower))) return false;
  if (g.not.some((n) => gateMatches(n, text, lower))) return false;
  return true;
}

// ─── regions (herdr's definitions) ──────────────────────────────────

function isHorizontalRule(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  let n = 0;
  for (const ch of t) {
    if (ch !== '─') break;
    n += 1;
  }
  if (n === 0) return false;
  const suffix = [...t].slice(n).join('').trimStart();
  return suffix === '' || n >= 3;
}

/** Offset in `content` where line `index` starts — herdr's
 *  line_start_offset: each line counts its length plus one newline,
 *  capped at the text's length. Regions are cut from the original text
 *  with it, so a region keeps its trailing newline exactly as in herdr. */
function lineOffset(content: string, lines: string[], index: number): number {
  let n = 0;
  for (let i = 0; i < Math.min(index, lines.length); i += 1) n += lines[i]!.length + 1;
  return Math.min(n, content.length);
}

function codexPromptLine(line: string): boolean {
  return line === '›' || line.startsWith('› ');
}
function codexBlockMarkerLine(line: string): boolean {
  return line.startsWith('•') || line.startsWith('■') || line.startsWith('✗') || line.startsWith('✓');
}
function currentCodexPromptIndex(lines: string[]): number | null {
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (codexPromptLine(lines[i]!)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  if (lines.slice(idx + 1).some(codexBlockMarkerLine)) return null;
  return idx;
}
function promptBoxTopBorderIndex(lines: string[]): number | null {
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isHorizontalRule(lines[i]!)) {
      count += 1;
      if (count === 2) return i;
    }
  }
  return null;
}

/** The text a rule with this region sees. */
export function regionText(input: DetectionInput, spec: string): string {
  const name = spec.trim();
  if (name === 'osc_title') return input.title ?? '';
  if (name === 'osc_progress') return input.progress ?? '';
  const content = input.screen;
  const lines = rustLines(content);
  switch (name) {
    case 'whole_recent':
      return content;
    case 'after_last_prompt_marker': {
      let idx = -1;
      for (let i = lines.length - 1; i >= 0; i -= 1) if (codexPromptLine(lines[i]!)) { idx = i; break; }
      return idx < 0 ? content : content.slice(lineOffset(content, lines, idx + 1));
    }
    case 'before_current_prompt_marker': {
      const idx = currentCodexPromptIndex(lines);
      return idx === null ? content : content.slice(0, lineOffset(content, lines, idx));
    }
    case 'whole_recent_without_current_prompt_marker':
      return currentCodexPromptIndex(lines) === null ? content : '';
    case 'current_prompt_block_marker': {
      const idx = currentCodexPromptIndex(lines);
      if (idx === null) return '';
      for (let i = idx - 1; i >= 0; i -= 1) if (codexBlockMarkerLine(lines[i]!)) return lines[i]!;
      return '';
    }
    case 'after_current_prompt_block_marker': {
      const idx = currentCodexPromptIndex(lines);
      if (idx === null) return '';
      for (let i = idx - 1; i >= 0; i -= 1) if (codexBlockMarkerLine(lines[i]!)) return content.slice(lineOffset(content, lines, i));
      return '';
    }
    case 'prompt_box_body': {
      const top = promptBoxTopBorderIndex(lines);
      if (top === null) return '';
      let end = lines.length;
      for (let i = top + 1; i < lines.length; i += 1) if (isHorizontalRule(lines[i]!)) { end = i; break; }
      return content.slice(lineOffset(content, lines, top + 1), lineOffset(content, lines, end));
    }
    case 'above_prompt_box': {
      const top = promptBoxTopBorderIndex(lines);
      return top === null ? content : content.slice(0, lineOffset(content, lines, top));
    }
    case 'last_non_empty_above_prompt_box': {
      const top = promptBoxTopBorderIndex(lines);
      const above = top === null ? lines : lines.slice(0, top);
      for (let i = above.length - 1; i >= 0; i -= 1) if (above[i]!.trim()) return above[i]!;
      return '';
    }
    case 'after_last_horizontal_rule': {
      let start = 0;
      lines.forEach((l, i) => {
        if (isHorizontalRule(l)) start = i + 1;
      });
      return content.slice(lineOffset(content, lines, start));
    }
  }
  const m = COUNTED_REGION.exec(name);
  if (!m) return '';
  const n = Number(m[2]);
  if (m[1] === 'bottom_lines') return content.slice(lineOffset(content, lines, Math.max(0, lines.length - n)));
  const nonEmpty = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  if (nonEmpty.length === 0) return '';
  if (m[1] === 'bottom_non_empty_lines') return content.slice(lineOffset(content, lines, nonEmpty[Math.max(0, nonEmpty.length - n)]!));
  const end = nonEmpty[Math.min(n, nonEmpty.length) - 1]!;
  return content.slice(0, lineOffset(content, lines, end + 1));
}

// ─── evaluation ─────────────────────────────────────────────────────

export const IDLE_FALLBACK = 'default_known_agent_idle_fallback';

/** Evaluate a compiled manifest. With `explain`, every rule's result. */
export function evaluate(
  compiled: CompiledManifest,
  input: DetectionInput,
  explain?: RuleEvaluation[],
): Detection {
  let best: ManifestRule | null = null;
  for (const { rule, gate } of compiled.rules) {
    const region = rule.region ?? 'whole_recent';
    const text = regionText(input, region);
    const matched = gateMatches(gate, text, text.toLowerCase());
    explain?.push({
      id: rule.id,
      state: rule.state ?? 'unknown',
      priority: rule.priority ?? 0,
      region,
      matched,
      regionPreview: text.length > 240 ? `${text.slice(0, 240)}...` : text,
    });
    if (matched && (best === null || (best.priority ?? 0) < (rule.priority ?? 0))) best = rule;
  }
  if (!best) {
    return { state: 'idle', skipStateUpdate: false, visibleIdle: false, visibleBlocker: false, visibleWorking: false, fallback: IDLE_FALLBACK };
  }
  const state = best.state ?? 'unknown';
  return {
    state,
    rule: { id: best.id, priority: best.priority ?? 0, region: best.region ?? 'whole_recent' },
    skipStateUpdate: best.skip_state_update === true,
    visibleIdle: best.visible_idle === true && state === 'idle',
    visibleBlocker: best.visible_blocker === true && state === 'blocked',
    visibleWorking: best.visible_working === true && state === 'working',
  };
}

/** The screen herdr evaluates: the last `rows` rows, trailing blank
 *  rows dropped. `capture` is tmux capture-pane output (may hold more
 *  history than the visible rows). */
export function detectionScreen(capture: string, rows: number): string {
  const lines = capture.replace(/\n$/, '').split('\n').slice(-Math.max(1, rows));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.join('\n');
}
