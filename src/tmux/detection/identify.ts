// Which coding agent runs in a terminal, from its foreground processes —
// so a tmux session needs no declared kind. After herdr's identification
// (src/detect/mod.rs): the names each agent's process goes by, and the
// script a runtime (node, bun, python, a shell's -c) runs.
//
// The foreground job is the process group the terminal currently gives
// its input to: in `ps -o pid=,pgid=,tpgid=,args= -t <tty>` the rows
// whose pgid equals tpgid. A shell that started the agent stays behind
// it in its own group; `sh -c "agent …; …"` shares the agent's group.

/** Process names → agent id (herdr's lookup_agent). */
const NAMES: Record<string, string> = {
  pi: 'pi',
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  devin: 'devin',
  'devin-cli': 'devin',
  agy: 'agy',
  antigravity: 'agy',
  'antigravity-cli': 'agy',
  cline: 'cline',
  omp: 'omp',
  mastracode: 'mastracode',
  'mastra-code': 'mastracode',
  opencode: 'opencode',
  opencode2: 'opencode',
  'open-code': 'opencode',
  copilot: 'copilot',
  'github-copilot': 'copilot',
  ghcs: 'copilot',
  kimi: 'kimi',
  'kimi-code': 'kimi',
  kiro: 'kiro',
  'kiro-cli': 'kiro',
  droid: 'droid',
  amp: 'amp',
  'amp-local': 'amp',
  grok: 'grok',
  'grok-build': 'grok',
  hermes: 'hermes',
  'hermes-agent': 'hermes',
  kilo: 'kilo',
  'kilo-code': 'kilo',
  qodercli: 'qodercli',
  qoderclicn: 'qodercli',
  qoder: 'qodercli',
  qodercn: 'qodercli',
  qwen: 'qwen',
  'qwen-code': 'qwen',
  letta: 'letta',
  'letta-code': 'letta',
  maki: 'maki',
  muse: 'muse',
  'muse-code': 'muse',
  'muse-cli': 'muse',
};

const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3', 'sh', 'bash', 'zsh', 'fish', 'dash']);

function basename(p: string): string {
  const b = p.replace(/\\/g, '/').split('/').pop() ?? p;
  return b.replace(/\.(exe|cmd|js|mjs|cjs|ts|py)$/i, '').toLowerCase();
}

/** The agent a process name stands for, or null. */
export function agentFromName(name: string): string | null {
  const b = basename(name);
  if (NAMES[b]) return NAMES[b]!;
  if (/^muse-bin-\d/.test(b)) return 'muse';
  return null;
}

/** The agent an argument list runs: its program, or the script a
 *  runtime runs (`node …/bin/codex`, `bash -c "pi --model …"`). */
export function agentFromArgv(argv: string[]): string | null {
  if (argv.length === 0) return null;
  const direct = agentFromName(argv[0]!);
  if (direct) return direct;
  const runtime = basename(argv[0]!).replace(/^-/, '').replace(/\d+(\.\d+)*$/, '');
  if (!RUNTIMES.has(runtime) && !RUNTIMES.has(basename(argv[0]!))) return null;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]!;
    // -c "<command>" (a shell) — its first word.
    if (a === '-c' && argv[i + 1] !== undefined) {
      const first = argv.slice(i + 1).join(' ').trim().split(/\s+/)[0] ?? '';
      return first ? agentFromName(first) : null;
    }
    // node -e / python -m and the like: not a script file.
    if (a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '-m') return null;
    if (a.startsWith('-')) continue;
    return agentFromName(a);
  }
  return null;
}

export interface ProcessRow {
  pid: number;
  pgid: number;
  /** The terminal's foreground process group. */
  tpgid: number;
  args: string;
}

/** Parse `ps -o pid=,pgid=,tpgid=,args= -t <tty>`. */
export function parsePs(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]), args: m[4]!.trim() });
  }
  return rows;
}

/** The agent in the terminal's foreground job, or null for a plain
 *  shell or another program. The group leader is asked first, then the
 *  rest of the group. */
export function identifyForeground(rows: ProcessRow[]): string | null {
  const fg = rows.filter((r) => r.tpgid > 0 && r.pgid === r.tpgid);
  fg.sort((a, b) => (a.pid === a.pgid ? -1 : 0) - (b.pid === b.pgid ? -1 : 0));
  for (const r of fg) {
    const agent = agentFromArgv(r.args.split(/\s+/).filter(Boolean));
    if (agent) return agent;
  }
  return null;
}

/** The ps command for a pane's terminal (`#{pane_tty}`). Works on Linux
 *  and macOS, locally or over SSH. */
export function psCommandForTty(tty: string): string {
  const name = tty.replace(/^\/dev\//, '');
  if (!/^[A-Za-z0-9/._-]+$/.test(name)) throw new Error(`unexpected tty "${tty}"`);
  return `ps -o pid=,pgid=,tpgid=,args= -t ${name}`;
}
