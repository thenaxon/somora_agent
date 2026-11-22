// The phone's file sheet (2026-11-22): a local file an agent linked in
// chat opens full screen instead of downloading in a new tab. No browser:
// renderToString runs no effects, so this checks what the markup says —
// the link still carries the byte route for "open in new tab", the
// sheet shows a back button and starts loading, and the history entry
// that lets the phone's back gesture close the sheet is read correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';

import { MARKDOWN_COMPONENTS } from './markdown.tsx';
import { FileSheet, errorLabel } from './FileSheet.tsx';
import { fileFromHistoryState } from '../hooks/useFileSheet.ts';

const md = (text: string): string =>
  renderToString(React.createElement(ReactMarkdown, { components: MARKDOWN_COMPONENTS }, text));

test('a link to a local file keeps the byte route as its href', () => {
  const html = md('[Catalog](/home/someone/work/CATALOG.md)');
  assert.match(html, /href="\/files\/raw\?path=%2Fhome%2Fsomeone%2Fwork%2FCATALOG\.md"/);
});

test('a web link stays a web link', () => {
  const html = md('[site](https://example.org/page)');
  assert.match(html, /href="https:\/\/example\.org\/page"/);
  assert.match(html, /target="_blank"/);
});

test('the sheet opens with a back button, the file name and a loading line', () => {
  const html = renderToString(
    React.createElement(FileSheet, { path: '/home/someone/work/CATALOG.md', onClose: () => {} }),
  );
  assert.match(html, /data-testid="file-sheet-back"/);
  assert.match(html, />CATALOG\.md</);
  assert.match(html, /loading…/);
});

test('error statuses read as words', () => {
  assert.equal(errorLabel(403), 'Access denied');
  assert.equal(errorLabel(404), 'File not found');
  assert.equal(errorLabel(0), 'Network error');
  assert.equal(errorLabel(500), 'Error 500');
});

test('the history entry names the open file, anything else names none', () => {
  assert.equal(fileFromHistoryState({ somoraFile: '/a/b.md' }), '/a/b.md');
  assert.equal(fileFromHistoryState({ somoraFile: '' }), null);
  assert.equal(fileFromHistoryState({ other: 1 }), null);
  assert.equal(fileFromHistoryState(null), null);
  assert.equal(fileFromHistoryState('x'), null);
});
