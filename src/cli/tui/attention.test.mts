// Title and bell for a TUI you are not looking at (2026-11-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFor, titleSequence } from './attention.ts';

test('the title marks what the session needs', () => {
  assert.equal(titleFor('working', 'ada:main'), '⏳ ada:main · somora');
  assert.equal(titleFor('question', 'ada:main'), '⚠ ada:main · somora');
  assert.equal(titleFor('done', 'ada:main'), '✓ ada:main · somora');
  assert.equal(titleFor('idle', 'ada:main'), 'ada:main · somora');
});

test('the title sequence carries no control characters of its own text', () => {
  assert.equal(titleSequence('a\x07b\x1bc'), '\x1b]2;a b c\x07');
});
