// somora mobile service-worker — minimal app-shell cache.
//
// The PWA itself doesn't try to be useful offline (somora's whole
// purpose is talking to the server). What this service-worker buys us:
//   - The browser treats the page as a "real" PWA → "add to home
//     screen" install prompt becomes available.
//   - When network drops (Tailscale disconnected, server restarting,
//     train going through a tunnel) the static shell still loads from
//     cache instead of showing the browser's "no internet" page —
//     UI then surfaces a "connection lost" banner once the JS runs.
//
// Cache strategy:
//   - On install: pre-fetch the app shell (index.html, css, js).
//   - On fetch: network-first for HTML (so JS rev'd through Vite hashes
//     gets seen immediately on each build), cache-first for hashed
//     assets, network-only for everything under /agents /chat /stt
//     /attachments /version /health etc. (those must be live).
//
// Versioning: bump CACHE_NAME on every change so old service-workers
// shed their stale shells on activate.

const CACHE_NAME = 'somora-mobile-v1';
const APP_SHELL = ['/mobile/', '/mobile/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache the live somora API surface — every call must hit
  // the server so the user always sees fresh agent state.
  const livePaths = ['/agents', '/chat', '/stt', '/attachments', '/files', '/dream', '/health', '/version', '/models', '/tools', '/tui-config'];
  if (livePaths.some((p) => url.pathname.startsWith(p))) {
    return; // default: passthrough to network
  }

  // Outside /mobile/ scope — don't intercept.
  if (!url.pathname.startsWith('/mobile/')) return;

  // HTML: network-first, cache-fallback. Lets us pick up Vite-bumped
  // asset hashes on every successful network hit.
  if (req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit ?? caches.match('/mobile/index.html'))),
    );
    return;
  }

  // Hashed assets (JS/CSS/icons): cache-first.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return res;
      });
    }),
  );
});
