// Custom web themes (src/server/themes.ts, docs/web.md "Themes").
// Both routes sit behind the login key like every other route.

import type { Hono } from 'hono';
import { listThemes, readWallpaper, type Theme, type ThemeBase, type ThemeVersion } from '../themes.ts';

function versionForClient(id: string, base: ThemeBase, v: ThemeVersion) {
  return {
    tokens: v.tokens,
    grid: v.grid,
    // The modification time in the URL: a replaced file gets a new address.
    wallpaperUrl: v.wallpaper ? `/themes/${encodeURIComponent(id)}/${base}/wallpaper?v=${v.wallpaperMtimeMs ?? 0}` : null,
  };
}

function forClient(t: Theme) {
  const versions: Partial<Record<ThemeBase, ReturnType<typeof versionForClient>>> = {};
  for (const base of ['dark', 'light'] as const) {
    const v = t.versions[base];
    if (v) versions[base] = versionForClient(t.id, base, v);
  }
  return { id: t.id, name: t.name, versions };
}

export function registerThemeRoutes(app: Hono): void {
  // GET /themes — the valid themes, and the invalid ones with the reason.
  app.get('/themes', async (c) => {
    const { themes, invalid } = await listThemes();
    return c.json({ themes: themes.map(forClient), invalid });
  });

  // GET /themes/:id/:base/wallpaper — a version's wallpaper, from the theme's own folder only.
  app.get('/themes/:id/:base/wallpaper', async (c) => {
    const base = c.req.param('base');
    if (base !== 'dark' && base !== 'light') return c.json({ error: 'the version is dark or light' }, 404);
    const res = await readWallpaper(c.req.param('id'), base);
    if ('error' in res) return c.json({ error: res.error }, res.status);
    return new Response(new Uint8Array(res.bytes), {
      headers: {
        'Content-Type': res.type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  });
}
