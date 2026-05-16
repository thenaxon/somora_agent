import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// somora web is served by the somora-server under `/web/*` in
// production, so the build emits relative-asset URLs anchored to
// that base path. In dev (`npm run dev`) Vite runs on :5173 and
// proxies API calls to the somora server on :18737 — same-origin
// in production, transparent proxy in dev.
//
// HTTPS in dev: when ~/.somora/certs/<host>.{crt,key} exist (produced
// by `tailscale cert <host>`), Vite serves over HTTP/2-over-TLS so the
// dev experience matches production. Without the cert files, falls
// back to plain HTTP/1.1 — fine for one-window debugging but you'll
// hit the 6-connection-per-origin limit fast with multi-agent setups.
// Set SOMORA_PUBLIC_HOST or SOMORA_TLS_HOST to your tailnet FQDN
// (e.g. `your-host.your-tailnet.ts.net`) so vite knows which cert
// pair to load.
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
  base: '/web/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Bind to all interfaces so the dev server is reachable from the
    // LAN / Tailscale (other devices browsing to
    // https://<your-host>.<your-tailnet>.ts.net:5173/web/). LAN+tailnet-only
    // by design — same threat model as the somora HTTP server, no auth.
    host: true,
    port: 5173,
    strictPort: true,
    ...(httpsConfig ? { https: httpsConfig } : {}),
    proxy: {
      // Each top-level somora HTTP route the web client calls. Listed
      // explicitly (not a single catchall) so unrelated requests don't
      // get forwarded. Target switches to https://<publicHost>:18737
      // when TLS is on so the parent server's cert-bound hostname is
      // honored end-to-end.
      '/agents': { target: proxyTarget, changeOrigin: true, secure: true },
      '/attachments': { target: proxyTarget, changeOrigin: true, secure: true },
      '/chat': { target: proxyTarget, changeOrigin: true, secure: true },
      '/dream': { target: proxyTarget, changeOrigin: true, secure: true },
      '/files': { target: proxyTarget, changeOrigin: true, secure: true },
      '/models': { target: proxyTarget, changeOrigin: true, secure: true },
      '/tools': { target: proxyTarget, changeOrigin: true, secure: true },
      '/tui-config': { target: proxyTarget, changeOrigin: true, secure: true },
      '/health': { target: proxyTarget, changeOrigin: true, secure: true },
      '/version': { target: proxyTarget, changeOrigin: true, secure: true },
      // /tmux carries both REST (/tmux/sessions) AND a WebSocket
      // upgrade (/tmux/attach). `ws: true` tells vite's proxy to
      // forward Upgrade requests, otherwise xterm.js can never
      // connect through the dev server.
      '/tmux': { target: proxyTarget, changeOrigin: true, secure: true, ws: true },
      // /terminal/attach is a WS upgrade (plain shell PTY).
      '/terminal': { target: proxyTarget, changeOrigin: true, secure: true, ws: true },
    },
  },
});
