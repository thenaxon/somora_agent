// The somora lettering shown once at the top of the installer, the setup
// assistant and an empty TUI session. install.sh carries the same lines
// (banner.test.mts holds the two together).

export const BANNER_WIDE: readonly string[] = [
  '███████╗ ██████╗ ███╗   ███╗ ██████╗ ██████╗  █████╗',
  '██╔════╝██╔═══██╗████╗ ████║██╔═══██╗██╔══██╗██╔══██╗',
  '███████╗██║   ██║██╔████╔██║██║   ██║██████╔╝███████║',
  '╚════██║██║   ██║██║╚██╔╝██║██║   ██║██╔══██╗██╔══██║',
  '███████║╚██████╔╝██║ ╚═╝ ██║╚██████╔╝██║  ██║██║  ██║',
  '╚══════╝ ╚═════╝ ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝',
];

export const BANNER_COMPACT: readonly string[] = [
  '┌─┐┌─┐┌┬┐┌─┐┬─┐┌─┐',
  '└─┐│ │││││ │├┬┘├─┤',
  '└─┘└─┘┴ ┴└─┘┴└─┴ ┴',
];

export const BANNER_TAGLINE = 'Build your own AI team. Local-first agents that never forget.';
export const BANNER_TAGLINE_SHORT = 'Local-first agents that never forget.';
export const BANNER_MOTTO = 'Run. Rest. Dream.';

export const BANNER_HEX = '#7EB89A';

/** Brand mint (#7EB89A) as a 24-bit colour escape. */
export const MINT = '\x1b[38;2;126;184;154m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

export type BannerShape = 'wide' | 'compact' | 'none';

/** Which lettering fits: none without a terminal or without UTF-8, the
 *  compact one below 60 columns. */
export function bannerShape(opts: { isTTY: boolean; columns: number | undefined; utf8: boolean }): BannerShape {
  if (!opts.isTTY || !opts.utf8) return 'none';
  const cols = opts.columns ?? 80;
  if (cols >= 60) return 'wide';
  return cols >= 22 ? 'compact' : 'none';
}

export function isUtf8Locale(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  // macOS terminals often leave LANG empty and are UTF-8 anyway.
  return /utf-?8/i.test(v) || (v === '' && process.platform === 'darwin');
}

/** The banner as text for a terminal, or '' when it does not fit.
 *  `subtitle` goes on the line under the tagline (version, what runs). */
export function renderBanner(subtitle: string, opts: { isTTY: boolean; columns: number | undefined; utf8: boolean }): string {
  const shape = bannerShape(opts);
  if (shape === 'none') return '';
  const lines = shape === 'wide' ? BANNER_WIDE : BANNER_COMPACT;
  const tagline = shape === 'wide' ? BANNER_TAGLINE : BANNER_TAGLINE_SHORT;
  return ['', ...lines.map((l) => `  ${MINT}${l}${RST}`), `  ${tagline}`, `  ${DIM}${BANNER_MOTTO}  ·  ${subtitle}${RST}`, ''].join('\n');
}
