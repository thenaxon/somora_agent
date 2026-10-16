// `somora agent rename <old> <new>` (docs/agents.md#renaming-an-agent): a
// thin client — the running server does the rename, so the agent's
// sessions, memory and connections it holds are let go of properly.

import { callServer } from './server-call.ts';

function usage(): string {
  return `Usage:
  somora agent rename <old> <new> [--dry-run]
      Rename an agent, somora's own or an external one: its folder with
      sessions and memory, team.yaml, Sentinel triggers, its browser
      profile and the config.yaml entries that name it. --dry-run lists
      what would change. The agent must be idle.
`;
}

interface Report {
  ok?: boolean;
  from?: string;
  to?: string;
  kind?: string;
  dryRun?: boolean;
  changes?: string[];
  warnings?: string[];
  error?: string;
}

export async function runAgentCli(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'rename') {
    process.stderr.write(usage());
    return sub === undefined || sub === '--help' || sub === '-h' ? 0 : 2;
  }
  const dryRun = rest.includes('--dry-run');
  const names = rest.filter((a) => !a.startsWith('--'));
  if (names.length !== 2) {
    process.stderr.write(usage());
    return 2;
  }
  const [from, to] = names as [string, string];
  let res: { status: number; json: Record<string, unknown> };
  try {
    res = await callServer(`/agents/${encodeURIComponent(from)}/rename`, { body: { to, dryRun }, timeoutMs: 60_000 });
  } catch (err) {
    process.stderr.write(`the server is not reachable: ${(err as Error).message}\nStart it with \`somora server start\`; the rename needs the running server.\n`);
    return 1;
  }
  const r = res.json as Report;
  if (!r.ok) {
    process.stderr.write(`${r.error ?? `HTTP ${res.status}`}\n`);
    return 1;
  }
  const head = r.dryRun ? `Would rename ${r.kind} agent '${r.from}' to '${r.to}':` : `Renamed ${r.kind} agent '${r.from}' to '${r.to}':`;
  process.stdout.write(`${head}\n${(r.changes ?? []).map((c) => `  - ${c}`).join('\n') || '  (nothing else to change)'}\n`);
  if ((r.warnings ?? []).length > 0) process.stdout.write(`\nStill to look at:\n${r.warnings!.map((w) => `  - ${w}`).join('\n')}\n`);
  return 0;
}
