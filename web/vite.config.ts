import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// somora web is served by the somora-server under `/web/*` in
// production, so the build emits relative-asset URLs anchored to
// that base path. In dev (`npm run dev`) Vite runs on :5173 and
// proxies API calls to the somora server on :18737 — same-origin
// in production, transparent proxy in dev.
export default defineConfig({
  plugins: [react()],
  base: '/web/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Bind to all interfaces so the dev server is reachable from the
    // LAN (other machines on the same network browsing to e.g.
    // http://naxon:5173). LAN-only-by-design — same threat model as
    // the somora HTTP server: trusted local network, no auth.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      // Each top-level somora HTTP route the web client calls. Listed
      // explicitly (not a single catchall) so unrelated requests
      // don't get forwarded.
      '/agents': 'http://127.0.0.1:18737',
      '/chat': 'http://127.0.0.1:18737',
      '/dream': 'http://127.0.0.1:18737',
      '/tools': 'http://127.0.0.1:18737',
      '/tui-config': 'http://127.0.0.1:18737',
      '/health': 'http://127.0.0.1:18737',
    },
  },
});
