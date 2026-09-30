import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aliasFor, CLAUDE_PRESET, CODEX_PRESET, pickPreferred } from './presets.ts';

const docs = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'models.md'), 'utf8');

test('every preset model is a documented one, with the documented alias and window', () => {
  for (const preset of [CLAUDE_PRESET, CODEX_PRESET]) {
    for (const m of preset.models) {
      const re = new RegExp(`- id: ${m.id.replace(/\./g, '\\.')}\\s*\\n\\s+alias: ${m.alias}\\s*\\n\\s+contextWindow: ${m.contextWindow}\\b`);
      assert.match(docs, re, `${m.id} / ${m.alias} / ${m.contextWindow} not found in docs/models.md`);
    }
  }
});

test('pickPreferred takes the first configured favourite, else the first model', () => {
  assert.equal(pickPreferred('chat', ['haiku', 'opus']), 'opus');
  assert.equal(pickPreferred('rem', ['opus', 'haiku']), 'haiku');
  assert.equal(pickPreferred('rem', ['llama']), 'llama');
  assert.equal(pickPreferred('chat', []), undefined);
});

test('aliasFor makes a safe, unique nickname', () => {
  assert.equal(aliasFor('qwen3:32b-instruct', []), 'qwen3-32b-instruct');
  assert.equal(aliasFor('meta/Llama-3.3', ['llama-3-3']), 'llama-3-3-2');
  assert.equal(aliasFor('///', []), 'model');
});
