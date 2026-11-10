// Moved unchanged from src/server/index.ts, which calls registerAttachmentRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import { storeAttachment } from '../../attachments/store.ts';
import { detectMimeFromPath } from '../../multimodal/mime.ts';
import { SOMORA_HOME_DIR, logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { existsSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';

export function registerAttachmentRoutes(app: Hono): void {
  // Phase Y.B — User-attachment upload. Streams the body into a tmp
  // file, sniffs MIME via magic-bytes (extensions are untrusted),
  // validates against per-kind caps, hashes, and atomically moves into
  // content-addressed storage at ~/.somora/attachments/<sha256>.<ext>.
  // Returns the metadata the client then references in /chat/send.
  //
  // Multipart parsing is intentionally avoided — Hono's parseBody pulls
  // the whole body into memory as a Buffer, which would defeat the
  // streaming caps. Clients send the raw bytes as the request body
  // with Content-Type: <mime> (sniffed server-side anyway) and the
  // filename via the X-Somora-Filename header.
  app.post('/attachments', async (c) => {
    const rawName =
      c.req.header('X-Somora-Filename') ||
      c.req.header('x-somora-filename') ||
      'unnamed';
    // Filenames travel URL-encoded so non-ASCII / spaces survive HTTP
    // header constraints. Decode before storing — display only.
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      name = rawName;
    }
    // A multipart body is stored verbatim by the streaming path below —
    // envelope, boundaries and all — and comes back as a text attachment
    // called "unnamed" with nobody the wiser (2026-09-11 report: a 790-byte
    // PNG arrived as a 947-byte text file and the turn simply had no
    // image). Raw bytes are deliberate here: multipart parsing pulls the
    // whole upload into RAM and would cost the streaming size cap. So say
    // so instead of silently storing the wrong thing.
    const contentType = c.req.header('Content-Type') ?? '';
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      return c.json(
        {
          error:
            'multipart uploads are not supported — send the raw file bytes as the request body ' +
            'with Content-Type set to the file type and the name in X-Somora-Filename ' +
            '(curl --data-binary @file.png -H "Content-Type: image/png" ' +
            '-H "X-Somora-Filename: file.png"). The response is ONE object; pass it in ' +
            'attachments[] on /chat/send or /chat/send-sync.',
        },
        415,
      );
    }
    const body = c.req.raw.body;
    if (!body) {
      return c.json({ error: 'request body required' }, 400);
    }
    try {
      const stored = await storeAttachment({
        body,
        name,
        config: config.attachments,
      });
      logger.info({
        msg: 'attachments.stored',
        hash: stored.hash,
        name: stored.name,
        mime: stored.mime.mimeType,
        kind: stored.mime.kind,
        size: stored.size,
      });
      return c.json({
        hash: stored.hash,
        name: stored.name,
        mime: stored.mime.mimeType,
        kind: stored.mime.kind,
        size: stored.size,
      });
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn({ msg: 'attachments.store_failed', name, err: msg });
      return c.json({ error: msg }, 400);
    }
  });

  // Serve a stored attachment by hash. Used by the web client to
  // display thumbnails of past-turn user-attachments (the bytes never
  // re-travel on /chat/send, so the bubble row needs a way to fetch
  // them). Loopback-trust same as everything else; sniffs MIME from
  // disk so a renamed-on-disk file can't claim a different content
  // type than its bytes say.
  app.get('/attachments/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return c.json({ error: 'invalid hash' }, 400);
    }
    const candidates = ['png', 'jpg', 'gif', 'webp', 'pdf', 'txt', 'bin'];
    for (const ext of candidates) {
      const p = `${SOMORA_HOME_DIR}/attachments/${hash}.${ext}`;
      if (existsSync(p)) {
        const bytes = await fsReadFile(p);
        const sniffed = await detectMimeFromPath(p);
        return new Response(bytes, {
          headers: {
            'Content-Type': sniffed.mimeType,
            // Long-cache: content is content-addressed, hash never re-issues different bytes.
            // private: the route is behind the login key, so no shared
            // cache may keep a copy; nosniff: served as the sniffed type
            // only (Fable review Nr. 28).
            'Cache-Control': 'private, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
    }
    return c.json({ error: 'not found' }, 404);
  });
}
