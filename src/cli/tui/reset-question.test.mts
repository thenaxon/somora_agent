// /reset YES archives the conversation and its open question with it:
// the TUI drops the question it still shows. A preview, a reset with
// nothing to archive and a failed reset leave a pending question alone.
// After packetloss99's fix in their fork (packetloss99/somora_agent#3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, type CommandContext } from './commands.ts';

function context(resetSession: () => Promise<unknown>): CommandContext {
  return {
    api: { resetSession },
    agent: 'ada',
    session: 'main',
    showMemory: false,
    showTools: false,
    verboseTools: false,
    verboseMemory: false,
    verboseSystem: false,
    verboseThinking: false,
  } as unknown as CommandContext;
}

test('a confirmed successful reset clears the archived conversation question', async () => {
  const actions = await runCommand('/reset YES', context(async () => ({ archivedId: 'old-main-archive', dreamSpawned: false })));
  assert.ok(actions.some((a) => a.kind === 'clearQuestion'));
  assert.ok(actions.some((a) => a.kind === 'clearStats'));
});

test('a reset preview does not clear a pending question or call the API', async () => {
  const actions = await runCommand('/reset', context(async () => {
    assert.fail('preview must not reset');
  }));
  assert.equal(actions.some((a) => a.kind === 'clearQuestion'), false);
});

test('a no-op or failed reset keeps a still-valid pending question', async () => {
  for (const reset of [
    async () => ({ archivedId: null, reason: 'nothing to archive' }),
    async () => {
      throw new Error('server unavailable');
    },
  ]) {
    const actions = await runCommand('/reset YES', context(reset));
    assert.equal(actions.some((a) => a.kind === 'clearQuestion'), false);
  }
});
