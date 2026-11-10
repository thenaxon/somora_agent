// What the bundled Codex hands the model under somora's lock-down: only
// Code Mode's own `exec` and `wait` — every other tool comes from somora
// as a dynamic tool. Runs the pinned binary's `debug prompt-input`
// (renders the model-visible input, no API call, no login) with the
// thread config somora sends, in an empty CODEX_HOME. A Codex bump that
// switches on a new tool of its own fails here instead of reaching an
// agent (found this way on the 0.167 bump: `clock` and `sleep`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexThreadConfig, codexConfigArgs } from './codex-thread-config.ts';
import { resolveCodexLaunch } from './codex-bin.ts';

function toolNames(items: unknown[]): string[] {
  const out: string[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      if (r.type !== 'namespace' && typeof r.name === 'string') out.push(r.name);
      Object.values(r).forEach(walk);
    }
  };
  walk(items.filter((i) => (i as { type?: string }).type === 'additional_tools'));
  return out.sort();
}

test('the bundled Codex offers the model no tool of its own beyond Code Mode', () => {
  const launch = resolveCodexLaunch();
  const home = mkdtempSync(join(tmpdir(), 'codex-surface-'));
  try {
    const run = (extra: string[]): unknown[] =>
      JSON.parse(
        execFileSync(launch.command, [...launch.args, 'debug', 'prompt-input', '-c', 'model="gpt-6-astra"', ...extra, 'test'], {
          env: { ...process.env, CODEX_HOME: home },
          encoding: 'utf8',
          timeout: 60_000,
        }),
      ) as unknown[];
    // Control: without somora's config Codex brings its own tools, so an
    // empty result below means the lock-down works, not that the dump
    // stopped listing tools.
    const bare = toolNames(run([]));
    assert.ok(bare.length > 2, `control run lists Codex's own tools: ${bare.join(', ')}`);
    const locked = toolNames(run(codexConfigArgs(buildCodexThreadConfig())));
    assert.deepEqual(locked, ['exec', 'wait'], `unexpected Codex tools: ${locked.join(', ')}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
