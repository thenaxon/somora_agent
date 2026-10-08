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

const BROWSERS = ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'];

export default defineConfig({
  plugins: [react()],
  base: '/mobile/',
  // web-mobile imports a few files from ../web/src (Koala.tsx, lib/*):
  // without dedupe their JSX would resolve web's own React copy.
  // plugin-react did this itself up to v4; v6 no longer does.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // Vite 8's default floor (browsers from 2023), spelled out with iOS
    // Safari included: without `ios`, Lightning CSS drops iOS-only
    // prefixes such as -webkit-text-size-adjust.
    target: BROWSERS,
    cssTarget: BROWSERS,
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
