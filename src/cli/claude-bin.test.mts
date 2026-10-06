// somora ships Claude Code through the Agent SDK's per-platform
// package; a login must find it without a separate install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { bundledClaudeBinary } from './claude-bin.ts';

test('the bundled Claude Code is found and runs', () => {
  const bin = bundledClaudeBinary();
  assert.ok(bin, 'a platform package of @anthropic-ai/claude-agent-sdk is installed');
  assert.ok(existsSync(bin!));
  const r = spawnSync(bin!, ['--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Claude Code/);
});
