// The dream one-shot (`codex exec`) gets the chat engine's lock-down as -c flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexThreadConfig, codexConfigArgs } from './codex-thread-config.ts';

test('the thread config becomes TOML-valued -c flags', () => {
  const args = codexConfigArgs({ 'features.shell_tool': false, web_search: 'disabled', project_root_markers: [], mcp_servers: {}, project_doc_max_bytes: 0, 'features.code_mode': { enabled: true, direct_only_tool_namespaces: ['a'] } });
  assert.deepEqual(args, ['-c', 'features.shell_tool=false', '-c', 'web_search="disabled"', '-c', 'project_root_markers=[]', '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0', '-c', 'features.code_mode.enabled=true', '-c', 'features.code_mode.direct_only_tool_namespaces=["a"]']);
});

test('the shell and web search are off on the one-shot path too', () => {
  const flat = codexConfigArgs(buildCodexThreadConfig()).filter((_, i) => i % 2 === 1);
  for (const want of ['features.shell_tool=false', 'features.unified_exec=false', 'web_search="disabled"', 'mcp_servers={}', 'features.plugins=false']) {
    assert.ok(flat.includes(want), want);
  }
});
