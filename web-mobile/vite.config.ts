import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// somora mobile is served by the somora-server under `/mobile/*` in
// production, so the build emits relative-asset URLs anchored to that
// base path. In dev (`npm run dev`) Vite runs on :5174 (distinct from
// web's :5173 so both dev-servers can run side by side) and proxies
// API calls to the somora server on :18737.
//
// HTTPS in dev: same Tailscale-cert pickup as `web/vite.config.ts` so
// the dev experience matches production. Without TLS, falls back to
// plain HTTP/1.1 — fine for one-window debugging.
const certsDir = resolve(homedir(), '.somora/certs');
const tlsHost =
  process.env.SOMORA_TLS_HOST ||
  process.env.SOMORA_PUBLIC_HOST ||
  '';
const certPath = resolve(certsDir, `${tlsHost}.crt`);
const keyPath = resolve(certsDir, `${tlsHost}.key`);
const tlsAvailable = existsSync(certPath) && existsSync(keyPath);
const httpsConfig = tlsAvailable
  ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
  : undefined;
const proxyTarget = tlsAvailable ? `https://${tlsHost}:18737` : 'http://127.0.0.1:18737';

export default defineConfig({
  plugins: [react()],
  base: '/mobile/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    ...(httpsConfig ? { https: httpsConfig } : {}),
    proxy: {
      // Same API surface as web/vite.config.ts — the mobile client only
      // uses a subset (no /tmux, /terminal WS), but proxying all in
      // case mobile-side code reaches for them in future polish.
      '/agents': { target: proxyTarget, changeOrigin: true, secure: true },
      '/attachments': { target: proxyTarget, changeOrigin: true, secure: true },
      '/chat': { target: proxyTarget, changeOrigin: true, secure: true },
      '/dream': { target: proxyTarget, changeOrigin: true, secure: true },
      '/files': { target: proxyTarget, changeOrigin: true, secure: true },
      '/models': { target: proxyTarget, changeOrigin: true, secure: true },
      '/tools': { target: proxyTarget, changeOrigin: true, secure: true },
      '/tui-config': { target: proxyTarget, changeOrigin: true, secure: true },
      '/mobile-config': { target: proxyTarget, changeOrigin: true, secure: true },
      '/stt': { target: proxyTarget, changeOrigin: true, secure: true },
      '/health': { target: proxyTarget, changeOrigin: true, secure: true },
      '/version': { target: proxyTarget, changeOrigin: true, secure: true },
    },
  },
});
