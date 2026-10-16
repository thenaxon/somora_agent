// The look of the web client (docs/web.md, "Theme" and "Themes").
// Two choices, both kept per browser:
//
//   - the theme: somora, the built-in one, or one of your own from
//     ~/.somora/themes/ (GET /themes);
//   - the mode: Dark (the default for a first visit), Light or Auto
//     (follows the system). somora has all three, and so has a theme
//     of your own with a dark and a light version. A theme with one
//     version stays on it.
//
// A theme of your own sets data-theme to the version in use, so
// everything the light theme does (tints, readable agent colours)
// follows it, and lays that version's colours over it as inline
// custom properties on <html>.
// The chosen theme is kept with its colours, so it is there before the
// first paint; GET /themes then confirms it, or the page falls back to
// somora.

export type ThemeMode = 'dark' | 'light' | 'auto';

/** One version of a theme of your own, dark or light. */
export interface WebThemeVersion {
  tokens: Record<string, string>;
  grid: boolean;
  wallpaperUrl: string | null;
}

/** A theme of your own as GET /themes describes it: at least one version. */
export interface WebTheme {
  id: string;
  name: string;
  /** `bundled`: comes with somora (Ocean); `own`: from ~/.somora/themes/.
   *  Missing from servers before bundled themes. */
  source?: 'bundled' | 'own';
  versions: Partial<Record<'dark' | 'light', WebThemeVersion>>;
}

/** The built-in theme's name in the menu. */
export const BUILT_IN_THEME_NAME = 'somora';

const MODE_KEY = 'somora.web.theme';
const CUSTOM_KEY = 'somora.web.theme.custom';

export function parseMode(v: string | null): ThemeMode {
  return v === 'light' || v === 'auto' ? v : 'dark';
}

export function readMode(): ThemeMode {
  try {
    return parseMode(window.localStorage.getItem(MODE_KEY));
  } catch {
    return 'dark';
  }
}

/** The theme of your own in use, or null for somora. */
export function readCustomTheme(): WebTheme | null {
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as WebTheme;
    const ok = t && typeof t.id === 'string' && t.versions && typeof t.versions === 'object' && (t.versions.dark || t.versions.light);
    return ok ? t : null;
  } catch {
    return null;
  }
}

function systemPrefersLight(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** Whether a theme follows the mode: somora and a theme with both versions do. */
function followsMode(custom: WebTheme | null): boolean {
  return !custom || (!!custom.versions.dark && !!custom.versions.light);
}

/** Dark or light in effect: the mode for somora and a theme with both
 *  versions, the one version a theme has otherwise. */
export function resolveTheme(mode: ThemeMode, prefersLight = systemPrefersLight(), custom: WebTheme | null = null): 'dark' | 'light' {
  if (!followsMode(custom)) return custom!.versions.dark ? 'dark' : 'light';
  if (mode === 'auto') return prefersLight ? 'light' : 'dark';
  return mode;
}

/** The modes the switch offers: all three when the theme follows the mode, its one version otherwise. */
export function modesFor(custom: WebTheme | null): ThemeMode[] {
  return followsMode(custom) ? ['dark', 'light', 'auto'] : [resolveTheme('dark', false, custom)];
}

/** The theme in use once the server's list is known: the same one with
 *  its current colours, or somora when it is gone or no longer valid. */
export function confirmTheme(custom: WebTheme | null, themes: WebTheme[]): WebTheme | null {
  if (!custom) return null;
  return themes.find((t) => t.id === custom.id) ?? null;
}

/** Custom properties set by the theme applied last, to take off again. */
let applied: string[] = [];

function apply(mode: ThemeMode, custom: WebTheme | null): void {
  const root = document.documentElement;
  for (const prop of applied) root.style.removeProperty(prop);
  applied = [];
  delete root.dataset.wallpaper;
  delete root.dataset.grid;

  const resolved = resolveTheme(mode, undefined, custom);
  root.dataset.theme = resolved;
  const version = custom?.versions[resolved];
  if (!version) return;
  for (const [prop, value] of Object.entries(version.tokens)) {
    if (!prop.startsWith('--')) continue;
    root.style.setProperty(prop, value);
    applied.push(prop);
  }
  if (version.wallpaperUrl) {
    root.style.setProperty('--desktop-wallpaper', `url(${JSON.stringify(version.wallpaperUrl)})`);
    applied.push('--desktop-wallpaper');
    root.dataset.wallpaper = '';
  }
  if (!version.grid) root.dataset.grid = 'off';
}

let mediaListener: (() => void) | null = null;

/** Apply the stored choice; on Auto, follow the system as it changes. */
export function startTheme(): void {
  apply(readMode(), readCustomTheme());
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
  if (mq && !mediaListener) {
    mediaListener = () => {
      if (readMode() === 'auto') apply('auto', readCustomTheme());
    };
    mq.addEventListener?.('change', mediaListener);
  }
}

/** Switch the mode. A theme with one version keeps it; the mode waits for somora or a theme with both. */
export function setMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* this page only */
  }
  apply(mode, readCustomTheme());
}

/** Switch the theme: one of your own, or null for somora (in the mode it had). */
export function selectTheme(custom: WebTheme | null): void {
  try {
    if (custom) window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
    else window.localStorage.removeItem(CUSTOM_KEY);
  } catch {
    /* this page only */
  }
  apply(readMode(), custom);
}

/** Bring the page in line with the server's list (GET /themes): an
 *  edited theme shows its new colours, a gone one falls back to somora.
 *  Returns the theme in use. */
export function syncThemes(themes: WebTheme[]): WebTheme | null {
  const current = readCustomTheme();
  if (!current) return null;
  const confirmed = confirmTheme(current, themes);
  selectTheme(confirmed);
  return confirmed;
}
