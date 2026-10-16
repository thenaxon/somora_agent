// Theme and mode: somora in Dark by default, Auto follows the system;
// a theme of your own with both versions follows the mode, one with a
// single version stays on it, and a gone theme falls back to somora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmTheme, modesFor, parseMode, resolveTheme, type WebTheme } from './theme';

const v = (accent: string) => ({ tokens: { '--accent': accent }, grid: true, wallpaperUrl: null });
const ocean: WebTheme = { id: 'ocean', name: 'Ocean', versions: { dark: v('#4fb3d9'), light: v('#1f6f99') } };
const night: WebTheme = { id: 'night', name: 'Night', versions: { dark: v('#4fb3d9') } };
const paper: WebTheme = { id: 'paper', name: 'Paper', versions: { light: v('#a54a1d') } };

test('somora: dark and light are what they say; auto follows the system', () => {
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
});

test('a stored mode: dark, light or auto; anything else is Dark', () => {
  assert.equal(parseMode(null), 'dark');
  assert.equal(parseMode('light'), 'light');
  assert.equal(parseMode('auto'), 'auto');
  for (const other of ['theme:ocean', 'purple', '']) assert.equal(parseMode(other), 'dark', other);
});

test('a theme with both versions follows the mode like somora', () => {
  assert.equal(resolveTheme('dark', true, ocean), 'dark');
  assert.equal(resolveTheme('light', false, ocean), 'light');
  assert.equal(resolveTheme('auto', true, ocean), 'light');
  assert.equal(resolveTheme('auto', false, ocean), 'dark');
});

test('a theme with one version stays on it, whatever the mode', () => {
  assert.equal(resolveTheme('light', true, night), 'dark');
  assert.equal(resolveTheme('auto', true, night), 'dark');
  assert.equal(resolveTheme('dark', false, paper), 'light');
});

test('the mode switch: all three for somora and two-version themes, the one version otherwise', () => {
  assert.deepEqual(modesFor(null), ['dark', 'light', 'auto']);
  assert.deepEqual(modesFor(ocean), ['dark', 'light', 'auto']);
  assert.deepEqual(modesFor(night), ['dark']);
  assert.deepEqual(modesFor(paper), ['light']);
});

test('confirmed against the server: the listed version is used, a gone or invalid theme falls back to somora', () => {
  const edited: WebTheme = { ...ocean, versions: { dark: v('#ff0000') } };
  assert.equal(confirmTheme(ocean, [edited, paper]), edited);
  assert.equal(confirmTheme(ocean, [paper]), null);
  assert.equal(confirmTheme(ocean, []), null);
  assert.equal(confirmTheme(null, [ocean]), null);
});
