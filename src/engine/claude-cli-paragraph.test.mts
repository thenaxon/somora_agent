// The text of a later request in a claude-cli turn starts a paragraph of
// its own instead of being glued to the previous request's last word.
import '../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endParagraph } from './claude-cli.ts';

test('a later request’s text starts a new paragraph', () => {
  assert.equal(endParagraph('Relative path, use the workspace.') + 'In logs/app.log', 'Relative path, use the workspace.\n\nIn logs/app.log');
  assert.equal(endParagraph('line\n') + 'next', 'line\n\nnext');
  assert.equal(endParagraph('done\n\n') + 'next', 'done\n\nnext');
  assert.equal(endParagraph(''), '');
});
