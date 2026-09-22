// Where a tool's full output goes when the model only gets part of it.
//
// exec fits its result to ~60k chars, the registry caps every result at
// its size cap, file_search budgets hit text. Until now the rest was
// gone — the model saw a cut and a hint to "narrow the command". Coding
// harnesses keep the full text in a file next to the tool result and
// hand the model the path, so it can `file_read` a window or
// `file_search` inside it instead of re-running the command. Same here:
// ~/.somora/agents/<agent>/tool-output/<tool>-<ts>-<rand>.<ext>
//
// Files are swept after TOOL_OUTPUT_RETENTION_MS (7 days): a sweep runs
// at boot and once an hour. The directory is under the agent's own
// home, so the read policy allows it and nothing else needs to know.

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function toolOutputDir(agent: string): string {
  return join(SOMORA_HOME, 'agents', agent, 'tool-output');
}

/**
 * Persist `text` for later paging. Returns the absolute path, or null
 * when writing failed (a missing file must never fail the tool call
 * itself — the caller then simply omits the path).
 */
export async function saveToolOutput(
  agent: string,
  tool: string,
  text: string,
  ext: 'txt' | 'json' = 'txt',
): Promise<string | null> {
  try {
    const dir = toolOutputDir(agent);
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const rand = Math.random().toString(36).slice(2, 6);
    const safeTool = tool.replace(/[^a-z0-9_-]/gi, '_');
    const file = join(dir, `${safeTool}-${ts}-${rand}.${ext}`);
    await writeFile(file, text, 'utf8');
    return file;
  } catch (err) {
    logger.warn({ msg: 'tool.output_save_failed', agent, tool, err: (err as Error).message });
    return null;
  }
}

/** Remove files older than the retention window for the given agents. */
export async function sweepToolOutput(agents: string[], now = Date.now()): Promise<number> {
  let removed = 0;
  for (const agent of agents) {
    const dir = toolOutputDir(agent);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      try {
        const st = await stat(p);
        if (now - st.mtimeMs > TOOL_OUTPUT_RETENTION_MS) {
          await rm(p, { force: true });
          removed++;
        }
      } catch {
        /* best-effort */
      }
    }
  }
  if (removed > 0) logger.info({ msg: 'tool.output_swept', removed });
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | undefined;

/** Boot hook: sweep now and every hour. Idempotent. */
export function startToolOutputSweeper(listAgents: () => Promise<string[]> | string[]): void {
  if (sweepTimer) return;
  const run = async () => {
    try {
      await sweepToolOutput(await listAgents());
    } catch (err) {
      logger.warn({ msg: 'tool.output_sweep_failed', err: (err as Error).message });
    }
  };
  void run();
  sweepTimer = setInterval(run, 60 * 60 * 1000);
  sweepTimer.unref?.();
}
