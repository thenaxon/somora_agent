// `--help` after a command shows help and never runs the command.
// Before, `somora init --help` set up the service, `somora server stop --help`
// stopped the server and `somora lsp install --help` installed language servers.

/** Commands that hand their arguments to another CLI, whose own `--help` must reach it. */
const PASS_THROUGH = new Set(['claude', 'auth', 'codex', 'grok']);

/** Commands without a usage text of their own: the general usage stands in. */
const NO_OWN_USAGE = new Set(['init', 'server', 'tui']);

export type HelpAction =
  | { kind: 'run' }
  | { kind: 'usage' }
  | { kind: 'module-help'; args: string[] };

export function helpAction(cmd: string | undefined, rest: readonly string[]): HelpAction {
  if (cmd === undefined || PASS_THROUGH.has(cmd)) return { kind: 'run' };
  if (!rest.some((a) => a === '--help' || a === '-h')) return { kind: 'run' };
  if (NO_OWN_USAGE.has(cmd)) return { kind: 'usage' };
  return { kind: 'module-help', args: ['--help'] };
}
