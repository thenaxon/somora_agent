// Custom web themes: discovery, theme.json validation, derived tokens,
// and that a wallpaper never comes from outside its theme folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { derivedTokens, listThemes, loadTheme, parseColor, readWallpaper, validateThemeJson, WALLPAPER_MAX_BYTES } from './themes.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function root(): string {
  return mkdtempSync(join(tmpdir(), 'somora-themes-'));
}

function theme(dir: string, id: string, json: unknown, files: Record<string, Buffer | string> = {}): string {
  const folder = join(dir, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'theme.json'), typeof json === 'string' ? json : JSON.stringify(json));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(folder, name), bytes);
  return folder;
}

test('colour values: hex, rgb() and hsl() in both syntaxes; anything else is refused', () => {
  assert.deepEqual(parseColor('#0b1620'), { r: 11, g: 22, b: 32, a: 1 });
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(92, 242, 214, 0.18)'), { r: 92, g: 242, b: 214, a: 0.18 });
  assert.deepEqual(parseColor('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('hsl(120deg 100% 25% / 0.5)'), { r: 0, g: 128, b: 0, a: 0.5 });
  for (const bad of ['red', 'transparent', '#12345', '#ggg', 'rgb(1, 2)', 'rgb(300, 0, 0)', 'rgb(1, 2, 3, 2)', 'hsl(0, 50, 50)',
    'rgb(1,2,3); background: url(x)', 'url(x)', 'var(--accent)', 'rgb(calc(1), 2, 3)', '']) {
    assert.equal(parseColor(bad), null, bad);
  }
});

test('theme.json: the documented format is accepted, defaults filled in', () => {
  const r = validateThemeJson({ name: 'Ocean', dark: { colors: { '--bg-0': '#0b1620', '--accent': '#4fb3d9' }, wallpaper: 'wallpaper.jpg' } }, 'ocean');
  assert.deepEqual(r, { ok: true, name: 'Ocean', versions: { dark: { colors: { '--bg-0': '#0b1620', '--accent': '#4fb3d9' }, wallpaper: 'wallpaper.jpg', grid: true } } });
  const bare = validateThemeJson({ light: {} }, 'plain');
  assert.deepEqual(bare, { ok: true, name: 'plain', versions: { light: { colors: {}, wallpaper: null, grid: true } } });
  const off = validateThemeJson({ dark: { grid: false } }, 'x');
  assert.equal(off.ok && off.versions.dark!.grid, false);
});

test('theme.json: a dark and a light version side by side, or just one of the two', () => {
  const both = validateThemeJson({
    name: 'Ocean',
    dark: { colors: { '--bg-0': '#06101c' }, grid: false },
    light: { colors: { '--bg-0': '#e6f2fb' }, wallpaper: 'day.webp' },
  }, 'ocean');
  assert.deepEqual(both, {
    ok: true,
    name: 'Ocean',
    versions: {
      dark: { colors: { '--bg-0': '#06101c' }, wallpaper: null, grid: false },
      light: { colors: { '--bg-0': '#e6f2fb' }, wallpaper: 'day.webp', grid: true },
    },
  });
  const lightOnly = validateThemeJson({ light: {} }, 'x');
  assert.deepEqual(lightOnly.ok && Object.keys(lightOnly.versions), ['light']);
});

test('theme.json: each block is checked on its own, and nothing but name and the blocks sits at the top', () => {
  const err = (raw: unknown) => {
    const r = validateThemeJson(raw, 'x');
    assert.equal(r.ok, false, JSON.stringify(raw));
    return (r as { error: string }).error;
  };
  assert.match(err({ dark: {}, base: 'dark' }), /unknown key "base"/);
  assert.match(err({ base: 'dark', colors: {} }), /unknown key "base"/);
  assert.match(err({ light: {}, colors: {} }), /unknown key "colors"/);
  assert.match(err({ dark: [] }), /"dark" must be an object/);
  assert.match(err({ dark: { name: 'x' } }), /"dark": unknown key "name"/);
  assert.match(err({ dark: {}, light: { colors: { '--accent': 'teal' } } }), /^"light": "--accent": "teal" is not a colour/);
  assert.match(err({ light: { colors: { '--bg-0': 'transparent' } } }), /"light": "--bg-0"/);
  assert.match(err({ dark: { wallpaper: '../x.png' } }), /"dark": "wallpaper" must be a file name inside the theme folder/);
});

test('theme.json: unknown keys, bad colours and wallpapers outside the folder are refused with a reason', () => {
  const err = (raw: unknown) => {
    const r = validateThemeJson(raw, 'x');
    assert.equal(r.ok, false, JSON.stringify(raw));
    return (r as { error: string }).error;
  };
  assert.match(err([]), /JSON object/);
  assert.match(err({ dark: {}, css: 'body{}' }), /^unknown key "css"/);
  assert.match(err({ name: 'Only a name' }), /a "dark" block, a "light" block or both/);
  assert.match(err({}), /a "dark" block, a "light" block or both/);
  assert.match(err({ dark: { colors: { '--window-radius': '#fff' } } }), /unknown colour token "--window-radius"/);
  assert.match(err({ dark: { colors: { '--accent-rgb': '1, 2, 3' } } }), /unknown colour token "--accent-rgb"/);
  assert.match(err({ dark: { colors: { '--accent': 'url(https://example.com/x)' } } }), /is not a colour/);
  assert.match(err({ dark: { colors: { '--accent': 3 } } }), /must be a string/);
  assert.match(err({ dark: { grid: 'no' } }), /"grid"/);
  assert.match(err({ name: '', dark: {} }), /"name" must be a non-empty string/);
  for (const w of ['../wallpaper.jpg', 'sub/wallpaper.jpg', '..', '/etc/x.png', 'a\\b.png']) {
    assert.match(err({ dark: { wallpaper: w } }), /inside the theme folder/, w);
  }
  assert.match(err({ dark: { wallpaper: 'wallpaper.gif' } }), /\.png, \.jpg or \.webp/);
  assert.match(err({ dark: { wallpaper: 'theme.svg' } }), /\.png, \.jpg or \.webp/);
});

test('transparent is allowed for the two glows only', () => {
  const ok = validateThemeJson({ dark: { colors: { '--glow-1': 'transparent', '--glow-2': 'TRANSPARENT' } } }, 'x');
  assert.deepEqual(ok.ok && ok.versions.dark!.colors, { '--glow-1': 'transparent', '--glow-2': 'transparent' });
  const bad = validateThemeJson({ dark: { colors: { '--bg-0': 'transparent' } } }, 'x');
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /"--bg-0".*not a colour/);
  assert.doesNotMatch((bad as { error: string }).error, /or transparent/);
});

test('derived tokens come from the given colours; nothing is derived from what is not given', () => {
  assert.deepEqual(derivedTokens({}), {});
  const d = derivedTokens({ '--accent': '#4fb3d9', '--bg-0': 'rgb(1 2 3)', '--bg-1': 'hsl(0, 0%, 100%)' });
  assert.equal(d['--accent-rgb'], '79, 179, 217');
  assert.equal(d['--bg-0-rgb'], '1, 2, 3');
  assert.equal(d['--bg-1-rgb'], '255, 255, 255');
  // Text on the accent: dark on a pale accent, white on a deep one.
  assert.equal(d['--on-accent'], '#0a1010');
  assert.equal(derivedTokens({ '--accent': '#1a237e' })['--on-accent'], '#ffffff');
  assert.equal(derivedTokens({ '--accent': '#5cf2d6' })['--on-accent'], '#0a1010', "the dark theme's own pairing");
});

test('discovery: valid themes with their tokens, invalid ones named with the reason, stray files ignored', async () => {
  const dir = root();
  theme(dir, 'ocean', { name: 'Ocean', dark: { colors: { '--accent': '#4fb3d9' }, wallpaper: 'wallpaper.png' } }, { 'wallpaper.png': PNG });
  theme(dir, 'paper', { light: { grid: false } });
  theme(dir, 'broken', '{ not json');
  theme(dir, 'nocolour', { dark: { colors: { '--accent': 'teal' } } });
  mkdirSync(join(dir, 'empty'));
  mkdirSync(join(dir, 'bad name'));
  writeFileSync(join(dir, 'loose.json'), '{"dark":{}}');
  writeFileSync(join(dir, '.DS_Store'), '');

  const { themes, invalid } = await listThemes(dir);
  assert.deepEqual(themes.map((t) => t.id), ['ocean', 'paper']);
  const ocean = themes[0]!;
  assert.equal(ocean.name, 'Ocean');
  assert.deepEqual(Object.keys(ocean.versions), ['dark']);
  assert.deepEqual(ocean.versions.dark!.tokens, { '--accent': '#4fb3d9', '--accent-rgb': '79, 179, 217', '--on-accent': '#0a1010' });
  assert.equal(ocean.versions.dark!.wallpaper, 'wallpaper.png');
  assert.equal(typeof ocean.versions.dark!.wallpaperMtimeMs, 'number');
  assert.equal(themes[1]!.versions.light!.grid, false);
  assert.equal(themes[1]!.name, 'paper');

  const reasons = Object.fromEntries(invalid.map((i) => [i.id, i.error]));
  assert.deepEqual(Object.keys(reasons).sort(), ['bad name', 'broken', 'empty', 'nocolour']);
  assert.match(reasons.broken!, /not valid JSON/);
  assert.match(reasons.empty!, /theme.json is missing/);
  assert.match(reasons.nocolour!, /"--accent": "teal" is not a colour/);
  assert.match(reasons['bad name']!, /folder name/);
});

test('no themes folder: an empty list, not an error', async () => {
  assert.deepEqual(await listThemes(join(root(), 'does-not-exist')), { themes: [], invalid: [] });
});

test('a missing wallpaper file makes the theme invalid', async () => {
  const dir = root();
  theme(dir, 'nopic', { dark: { wallpaper: 'gone.jpg' } });
  const t = await loadTheme('nopic', dir);
  assert.match((t as { error: string }).error, /"gone.jpg" not found/);
});

test('path safety: a wallpaper symlinked out of the folder, a linked theme folder and odd ids are refused', async () => {
  const dir = root();
  const outside = mkdtempSync(join(tmpdir(), 'somora-outside-'));
  writeFileSync(join(outside, 'secret.png'), PNG);
  const folder = theme(dir, 'sneaky', { dark: { wallpaper: 'w.png' } });
  symlinkSync(join(outside, 'secret.png'), join(folder, 'w.png'));
  assert.match(((await loadTheme('sneaky', dir)) as { error: string }).error, /leads out of the theme folder/);
  const res = await readWallpaper('sneaky', 'dark', dir);
  assert.ok('error' in res);

  // A whole theme folder that is a link to somewhere else.
  const elsewhere = theme(outside, 'real', { dark: {} });
  symlinkSync(elsewhere, join(dir, 'linked'));
  assert.match(((await loadTheme('linked', dir)) as { error: string }).error, /not a file or a link/);

  for (const id of ['..', '../x', 'a/b', '.hidden', '']) {
    const r = await readWallpaper(id, 'dark', dir);
    assert.ok('error' in r, id);
  }
});

test('a symlink inside the folder that stays inside it is fine', async () => {
  const dir = root();
  const folder = theme(dir, 'inner', { dark: { wallpaper: 'w.png' } }, { 'real.png': PNG });
  symlinkSync(join(folder, 'real.png'), join(folder, 'w.png'));
  const res = await readWallpaper('inner', 'dark', dir);
  assert.ok(!('error' in res));
});

test('wallpaper: served with its type; a file that is not the image its name says is refused; size limit', async () => {
  const dir = root();
  theme(dir, 'good', { dark: { wallpaper: 'w.jpg' } }, { 'w.jpg': JPG });
  const ok = await readWallpaper('good', 'dark', dir);
  assert.ok(!('error' in ok));
  assert.equal(ok.type, 'image/jpeg');
  assert.deepEqual(ok.bytes, JPG);

  theme(dir, 'fake', { dark: { wallpaper: 'w.png' } }, { 'w.png': '<svg onload="alert(1)"/>' });
  const fake = await readWallpaper('fake', 'dark', dir);
  assert.ok('error' in fake);
  assert.match(fake.error, /not a PNG image/);

  theme(dir, 'huge', { dark: { wallpaper: 'w.png' } }, { 'w.png': Buffer.alloc(WALLPAPER_MAX_BYTES + 1) });
  assert.match(((await loadTheme('huge', dir)) as { error: string }).error, /larger than/);

  const none = await readWallpaper('nothere', 'dark', dir);
  assert.ok('error' in none && none.status === 404);
  theme(dir, 'plain', { dark: {} });
  const plain = await readWallpaper('plain', 'dark', dir);
  assert.ok('error' in plain && plain.status === 404);
});

test('wallpaper per version: each version serves its own file, a missing version is a 404', async () => {
  const dir = root();
  theme(dir, 'daynight', { dark: { wallpaper: 'night.png' }, light: { wallpaper: 'day.jpg' } }, { 'night.png': PNG, 'day.jpg': JPG });
  const night = await readWallpaper('daynight', 'dark', dir);
  const day = await readWallpaper('daynight', 'light', dir);
  assert.ok(!('error' in night) && night.type === 'image/png');
  assert.ok(!('error' in day) && day.type === 'image/jpeg');

  theme(dir, 'nightonly', { dark: { wallpaper: 'night.png' } }, { 'night.png': PNG });
  const none = await readWallpaper('nightonly', 'light', dir);
  assert.ok('error' in none && none.status === 404);
  assert.match(none.error, /no light version/);

  // A wallpaper missing in one version makes the whole theme invalid.
  theme(dir, 'halfbroken', { dark: {}, light: { wallpaper: 'gone.png' } });
  assert.match(((await loadTheme('halfbroken', dir)) as { error: string }).error, /"gone.png" not found/);
});
