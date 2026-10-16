// Custom web themes (docs/web.md, "Themes"). A theme is a folder
// ~/.somora/themes/<id>/ with a theme.json: a name and a dark version,
// a light version or both. A version is colour values for the
// documented tokens, an optional wallpaper inside the folder and an
// optional grid switch. Nothing else: no CSS, no url(), so a theme
// cannot change the layout or load anything from another website.
//
// Everything here is validated on each read. The web client gets the
// tokens to set, derived ones included; the wallpaper bytes come from
// readWallpaper(), which checks the path and the image type again.

import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';

/** Colour tokens a theme may set (web/src/styles/tokens.css). */
export const THEME_COLOR_TOKENS = [
  '--bg-0', '--bg-1', '--bg-2', '--bg-3',
  '--line', '--line-2',
  '--text-0', '--text-1', '--text-2', '--text-3',
  '--accent', '--accent-dim', '--accent-glow',
  '--warn', '--danger', '--ok',
  '--grid', '--grid-strong',
  '--glow-1', '--glow-2',
] as const;

/** Tokens that may also be `transparent`: the desktop glows, so a theme can switch them off. */
const MAY_BE_TRANSPARENT = new Set<string>(['--glow-1', '--glow-2']);

const WALLPAPER_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Largest wallpaper served, in bytes. */
export const WALLPAPER_MAX_BYTES = 20 * 1024 * 1024;

/** Largest theme.json read, in bytes. */
const THEME_JSON_MAX_BYTES = 64 * 1024;

/** A folder name usable as a theme id (it ends up in a URL). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Keys of a version, inside its "dark" or "light" block. */
const VERSION_KEYS = ['colors', 'wallpaper', 'grid'] as const;
const TOP_LEVEL_KEYS = new Set(['name', 'dark', 'light']);

export type ThemeBase = 'dark' | 'light';

/** One version of a theme, dark or light. */
export interface ThemeVersion {
  /** Every token to set on the page: the version's colours plus the derived ones. */
  tokens: Record<string, string>;
  grid: boolean;
  /** Wallpaper file name inside the theme folder, if any. */
  wallpaper: string | null;
  /** The wallpaper's modification time, so the client URL changes when the file does. */
  wallpaperMtimeMs: number | null;
}

export interface Theme {
  id: string;
  name: string;
  /** At least one of the two. */
  versions: Partial<Record<ThemeBase, ThemeVersion>>;
}

export interface InvalidTheme {
  id: string;
  error: string;
}

export function themesDir(home = process.env.SOMORA_HOME ?? join(homedir(), '.somora')): string {
  return join(home, 'themes');
}

// ── Colour values ───────────────────────────────────────────────────

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A number with an optional unit, as written inside rgb() or hsl(). */
const PART_RE = /^\+?(\d+(?:\.\d+)?|\.\d+)(%|deg)?$/i;

function part(s: string): { n: number; unit: string } | null {
  const m = PART_RE.exec(s);
  return m ? { n: Number(m[1]), unit: (m[2] ?? '').toLowerCase() } : null;
}

/** The arguments of rgb()/hsl() in either syntax: "a, b, c[, d]" or "a b c[ / d]". */
function args(body: string): Array<{ n: number; unit: string }> | null {
  let raw: string[];
  if (body.includes(',')) {
    raw = body.split(',').map((s) => s.trim());
    if (raw.length !== 3 && raw.length !== 4) return null;
  } else {
    const [main, a, ...more] = body.split('/');
    if (more.length) return null;
    raw = main!.trim().split(/\s+/);
    if (raw.length !== 3) return null;
    if (a !== undefined) raw.push(a.trim());
  }
  const out = raw.map(part);
  return out.every((p) => p !== null) ? (out as Array<{ n: number; unit: string }>) : null;
}

function alpha(p: { n: number; unit: string } | undefined): number | null {
  if (!p) return 1;
  if (p.unit === 'deg') return null;
  const a = p.unit === '%' ? p.n / 100 : p.n;
  return a >= 0 && a <= 1 ? a : null;
}

/** The colour a value stands for, or null when it is not one of the accepted forms. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const full = hex[1]!.length === 3 ? hex[1]!.replace(/./g, (c) => c + c) : hex[1]!;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(v);
  if (!fn) return null;
  const list = args(fn[2]!);
  if (!list) return null;
  const a = alpha(list[3]);
  if (a === null) return null;
  if (fn[1]!.toLowerCase().startsWith('rgb')) {
    if (list.slice(0, 3).some((p) => p.unit === 'deg')) return null;
    const ch = list.slice(0, 3).map((p) => (p.unit === '%' ? (p.n / 100) * 255 : p.n));
    if (ch.some((c) => c > 255)) return null;
    return { r: Math.round(ch[0]!), g: Math.round(ch[1]!), b: Math.round(ch[2]!), a };
  }
  const [h, s, l] = list as [{ n: number; unit: string }, { n: number; unit: string }, { n: number; unit: string }];
  if (h.unit === '%' || s.unit !== '%' || l.unit !== '%' || s.n > 100 || l.n > 100) return null;
  return { ...hslToRgb(h.n % 360, s.n / 100, l.n / 100), a };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function luminance({ r, g, b }: Rgba): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** The dark theme's text colour on an accent surface, and white: whichever reads better on the accent. */
const ON_ACCENT_DARK = '#0a1010';
const ON_ACCENT_LIGHT = '#ffffff';

function onAccent(accent: Rgba): string {
  const l = luminance(accent);
  const dark = luminance(parseColor(ON_ACCENT_DARK)!);
  return (l + 0.05) / (dark + 0.05) >= 1.05 / (l + 0.05) ? ON_ACCENT_DARK : ON_ACCENT_LIGHT;
}

/** The tokens the page derives from a theme's colours instead of taking them by hand. */
export function derivedTokens(colors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const channels = (c: Rgba) => `${c.r}, ${c.g}, ${c.b}`;
  const accent = colors['--accent'] ? parseColor(colors['--accent']) : null;
  if (accent) {
    out['--accent-rgb'] = channels(accent);
    out['--on-accent'] = onAccent(accent);
  }
  for (const [token, derived] of [['--bg-0', '--bg-0-rgb'], ['--bg-1', '--bg-1-rgb']] as const) {
    const c = colors[token] ? parseColor(colors[token]) : null;
    if (c) out[derived] = channels(c);
  }
  return out;
}

// ── theme.json ──────────────────────────────────────────────────────

export interface ParsedVersion {
  colors: Record<string, string>;
  wallpaper: string | null;
  grid: boolean;
}

export type ParsedThemeJson =
  | { ok: true; name: string; versions: Partial<Record<ThemeBase, ParsedVersion>> }
  | { ok: false; error: string };

/** Check one version's colours, wallpaper and grid. `where` prefixes the error, e.g. `"dark": `. */
function validateVersion(obj: Record<string, unknown>, where: string): { ok: true; version: ParsedVersion } | { ok: false; error: string } {
  const colors: Record<string, string> = {};
  if (obj.colors !== undefined) {
    if (!obj.colors || typeof obj.colors !== 'object' || Array.isArray(obj.colors)) return { ok: false, error: `${where}"colors" must be an object` };
    const allowed = new Set<string>(THEME_COLOR_TOKENS);
    for (const [token, value] of Object.entries(obj.colors as Record<string, unknown>)) {
      if (!allowed.has(token)) return { ok: false, error: `${where}unknown colour token "${token}"` };
      if (typeof value !== 'string') return { ok: false, error: `${where}"${token}" must be a string` };
      const v = value.trim();
      if (v.toLowerCase() === 'transparent' && MAY_BE_TRANSPARENT.has(token)) {
        colors[token] = 'transparent';
        continue;
      }
      if (!parseColor(v)) {
        const also = MAY_BE_TRANSPARENT.has(token) ? ', or transparent' : '';
        return { ok: false, error: `${where}"${token}": "${value}" is not a colour (use #rgb, #rrggbb, rgb() or hsl()${also})` };
      }
      colors[token] = v;
    }
  }

  let wallpaper: string | null = null;
  if (obj.wallpaper !== undefined) {
    if (typeof obj.wallpaper !== 'string') return { ok: false, error: `${where}"wallpaper" must be a file name` };
    const w = obj.wallpaper;
    if (!w || w === '.' || w === '..' || /[\\/]/.test(w) || w.includes('\0')) {
      return { ok: false, error: `${where}"wallpaper" must be a file name inside the theme folder` };
    }
    if (!WALLPAPER_TYPES[extension(w)]) return { ok: false, error: `${where}"wallpaper" must be a .png, .jpg or .webp file` };
    wallpaper = w;
  }

  let grid = true;
  if (obj.grid !== undefined) {
    if (typeof obj.grid !== 'boolean') return { ok: false, error: `${where}"grid" must be true or false` };
    grid = obj.grid;
  }

  return { ok: true, version: { colors, wallpaper, grid } };
}

/** Check a parsed theme.json against the format. Wallpaper files are checked separately. */
export function validateThemeJson(raw: unknown, id: string): ParsedThemeJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'theme.json must be a JSON object' };
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key)) return { ok: false, error: `unknown key "${key}" (allowed: ${[...TOP_LEVEL_KEYS].join(', ')})` };
  }

  let name = id;
  if (obj.name !== undefined) {
    if (typeof obj.name !== 'string' || !obj.name.trim()) return { ok: false, error: '"name" must be a non-empty string' };
    if (obj.name.length > 64) return { ok: false, error: '"name" must be at most 64 characters' };
    name = obj.name.trim();
  }

  const blocks = (['dark', 'light'] as const).filter((b) => obj[b] !== undefined);
  if (blocks.length === 0) return { ok: false, error: 'a theme needs a "dark" block, a "light" block or both' };
  const versions: Partial<Record<ThemeBase, ParsedVersion>> = {};
  for (const b of blocks) {
    const block = obj[b];
    if (!block || typeof block !== 'object' || Array.isArray(block)) return { ok: false, error: `"${b}" must be an object` };
    for (const key of Object.keys(block)) {
      if (!(VERSION_KEYS as readonly string[]).includes(key)) return { ok: false, error: `"${b}": unknown key "${key}" (allowed: ${VERSION_KEYS.join(', ')})` };
    }
    const v = validateVersion(block as Record<string, unknown>, `"${b}": `);
    if (!v.ok) return v;
    versions[b] = v.version;
  }
  return { ok: true, name, versions };
}

function extension(file: string): string {
  const i = file.lastIndexOf('.');
  return i < 0 ? '' : file.slice(i).toLowerCase();
}

// ── Files ───────────────────────────────────────────────────────────

/** A file path inside dir that stays inside it once symlinks are resolved, or an error. */
async function insideFolder(dir: string, file: string): Promise<{ path: string } | { error: string }> {
  let realDir: string;
  let realFile: string;
  try {
    realDir = await realpath(dir);
    realFile = await realpath(join(dir, file));
  } catch {
    return { error: `wallpaper "${file}" not found in the theme folder` };
  }
  if (!realFile.startsWith(realDir + sep)) return { error: `wallpaper "${file}" leads out of the theme folder` };
  const st = await stat(realFile);
  if (!st.isFile()) return { error: `wallpaper "${file}" is not a file` };
  if (st.size > WALLPAPER_MAX_BYTES) return { error: `wallpaper "${file}" is larger than ${WALLPAPER_MAX_BYTES / 1024 / 1024} MB` };
  return { path: realFile };
}

/** Read and check one theme folder. */
export async function loadTheme(id: string, root = themesDir()): Promise<Theme | InvalidTheme> {
  if (!ID_RE.test(id)) return { id, error: 'folder name must be letters, digits, - and _ (up to 64)' };
  const dir = join(root, id);
  const dirStat = await lstat(dir).catch(() => null);
  if (!dirStat) return { id, error: 'no such theme' };
  if (!dirStat.isDirectory()) return { id, error: 'a theme is a folder, not a file or a link' };

  const jsonPath = join(dir, 'theme.json');
  const jsonStat = await lstat(jsonPath).catch(() => null);
  if (!jsonStat) return { id, error: 'theme.json is missing' };
  if (!jsonStat.isFile()) return { id, error: 'theme.json must be a file' };
  if (jsonStat.size > THEME_JSON_MAX_BYTES) return { id, error: 'theme.json is too large' };

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (err) {
    return { id, error: `theme.json is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = validateThemeJson(raw, id);
  if (!parsed.ok) return { id, error: parsed.error };

  const versions: Partial<Record<ThemeBase, ThemeVersion>> = {};
  for (const [base, v] of Object.entries(parsed.versions) as Array<[ThemeBase, ParsedVersion]>) {
    let wallpaperMtimeMs: number | null = null;
    if (v.wallpaper) {
      const found = await insideFolder(dir, v.wallpaper);
      if ('error' in found) return { id, error: found.error };
      // The image type on the bytes already here, not only when served:
      // a theme listed as valid must not leave the desktop blank when picked.
      const type = WALLPAPER_TYPES[extension(v.wallpaper)]!;
      if (!looksLike(type, await headBytes(found.path))) {
        return { id, error: `wallpaper "${v.wallpaper}" is not a ${type.slice(6).toUpperCase()} image` };
      }
      wallpaperMtimeMs = Math.floor((await stat(found.path)).mtimeMs);
    }
    versions[base] = {
      tokens: { ...v.colors, ...derivedTokens(v.colors) },
      grid: v.grid,
      wallpaper: v.wallpaper,
      wallpaperMtimeMs,
    };
  }
  return { id, name: parsed.name, versions };
}

/** Every folder under the themes folder, valid or not, sorted by id. Files lying next to them are ignored. */
export async function listThemes(root = themesDir()): Promise<{ themes: Theme[]; invalid: InvalidTheme[] }> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const themes: Theme[] = [];
  const invalid: InvalidTheme[] = [];
  const ids = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).filter((n) => !n.startsWith('.')).sort();
  for (const id of ids) {
    const t = await loadTheme(id, root);
    if ('error' in t) invalid.push(t);
    else themes.push(t);
  }
  return { themes, invalid };
}

/** The first bytes of a file, enough for looksLike. */
async function headBytes(path: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function looksLike(type: string, bytes: Buffer): boolean {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/webp') return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/** A valid theme's wallpaper bytes and type, checked again on every read. */
export async function readWallpaper(
  id: string,
  base: ThemeBase,
  root = themesDir(),
): Promise<{ bytes: Buffer; type: string } | { error: string; status: 404 | 422 }> {
  const theme = await loadTheme(id, root);
  if ('error' in theme) return { error: theme.error, status: theme.error === 'no such theme' ? 404 : 422 };
  const version = theme.versions[base];
  if (!version) return { error: `this theme has no ${base} version`, status: 404 };
  if (!version.wallpaper) return { error: `the ${base} version has no wallpaper`, status: 404 };
  const found = await insideFolder(join(root, id), version.wallpaper);
  if ('error' in found) return { error: found.error, status: 422 };
  const type = WALLPAPER_TYPES[extension(version.wallpaper)]!;
  const bytes = await readFile(found.path);
  if (!looksLike(type, bytes)) return { error: `wallpaper "${version.wallpaper}" is not a ${type.slice(6).toUpperCase()} image`, status: 422 };
  return { bytes, type };
}
