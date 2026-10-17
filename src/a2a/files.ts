// Files and images over A2A (docs/a2a.md#images-and-files).
//
//   - Download links: a signed, short-lived address for one attachment,
//     `/a2a/files/<token>`, open without the login key (the token is the
//     key). For peers that do not take a file in the message itself.
//   - Outgoing parts: an attachment goes into the message as a file part
//     when the peer's card accepts its type, else as a link in the text.
//   - Incoming parts: file parts a peer sends (bytes, or a URL fetched
//     with web_fetch's guard against internal addresses) become somora
//     attachments, as if typed into the chat.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fetch as undiciFetch } from 'undici';
import type { Context, Hono } from 'hono';
import { resolveAttachmentByHash, storeAttachment } from '../attachments/store.ts';
import type { AttachmentsConfig } from '../config/types.ts';
import { readKeyFile } from '../server/auth-key.ts';
import { logger } from '../server/logger.ts';
import { fetchFailure, getGuardedAgent, ssrfCheck } from '../tools/web/fetch.ts';
import type { A2APart, AgentCard, ProtocolVersion } from './protocol.ts';

export interface AttachmentRef {
  hash: string;
  name: string;
  mime: string;
  size: number;
}

/** How long a download link works. */
export const FILE_LINK_TTL_MS = 60 * 60 * 1000;
/** Biggest file sent inside a message; bigger ones go as a link. */
export const MAX_INLINE_BYTES = 8 * 1024 * 1024;
/** At most this many files in one incoming message. */
export const MAX_INCOMING_FILES = 5;

// ── download links ────────────────────────────────────────────────────

let fallbackSecret: Buffer | null = null;
/** The server's login key signs the links: a rotated key ends them all. */
function secret(): Buffer {
  const key = readKeyFile();
  if (key) return Buffer.from(`a2a-file-link:${key}`);
  fallbackSecret ??= randomBytes(32);
  return fallbackSecret;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function fileLinkToken(file: AttachmentRef, now = Date.now(), ttlMs = FILE_LINK_TTL_MS): string {
  const payload = b64(JSON.stringify({ h: file.hash, m: file.mime, n: file.name, e: now + ttlMs }));
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyFileLink(token: string, now = Date.now()): { hash: string; mime: string; name: string } | { error: string } {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return { error: 'not a file link' };
  // Compared as text: base64url's last character carries two spare bits
  // that decoding ignores, so a byte comparison would take a second
  // spelling of the same signature.
  const want = Buffer.from(createHmac('sha256', secret()).update(payload).digest('base64url'));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: 'not a file link' };
  let data: { h?: unknown; m?: unknown; n?: unknown; e?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof data;
  } catch {
    return { error: 'not a file link' };
  }
  if (typeof data.e !== 'number' || now > data.e) return { error: 'this link has expired' };
  if (typeof data.h !== 'string' || !/^[a-f0-9]{64}$/.test(data.h) || typeof data.m !== 'string') return { error: 'not a file link' };
  return { hash: data.h, mime: data.m, name: typeof data.n === 'string' ? data.n : 'file' };
}

export function fileLinkUrl(base: string, file: AttachmentRef): string {
  return `${base.replace(/\/+$/, '')}/a2a/files/${fileLinkToken(file)}`;
}

export function registerA2AFileRoutes(app: Hono): void {
  app.get('/a2a/files/:token', async (c: Context) => {
    const v = verifyFileLink(c.req.param('token') ?? '');
    if ('error' in v) return c.json({ error: v.error }, v.error === 'this link has expired' ? 410 : 404);
    let file: Awaited<ReturnType<typeof resolveAttachmentByHash>>;
    try {
      file = await resolveAttachmentByHash({ hash: v.hash, expectedMime: v.mime });
    } catch {
      return c.json({ error: 'the file is gone' }, 404);
    }
    const safeName = v.name.replace(/["\\\r\n]/g, '_');
    return new Response(Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream, {
      headers: {
        'Content-Type': v.mime,
        'Content-Length': String(file.size),
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Cache-Control': 'private, max-age=600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}

// ── outgoing ──────────────────────────────────────────────────────────

/** Whether the peer's card takes this type inside a message. */
export function cardAccepts(card: AgentCard, mime: string): boolean {
  const modes = (card.defaultInputModes ?? []).map((m) => m.toLowerCase());
  const type = mime.toLowerCase();
  return modes.includes(type) || modes.includes(`${type.split('/')[0]}/*`) || modes.includes('*/*');
}

/** A 1.0 file part rebuilt in the 0.3 shape, for a peer that turned out
 *  to speak 0.3. Other parts stay as they are. */
export function filePartAs03(p: A2APart): A2APart {
  if (typeof p.raw !== 'string' && typeof p.url !== 'string') return p;
  return filePart('0.3', { ...(p.raw ? { raw: p.raw } : { url: p.url! }), mediaType: p.mediaType ?? 'application/octet-stream', filename: p.filename ?? 'file' });
}

export function filePart(version: ProtocolVersion, p: { raw?: string; url?: string; mediaType: string; filename: string }): A2APart {
  if (version === '0.3') {
    return { kind: 'file', file: { ...(p.raw ? { bytes: p.raw } : { uri: p.url }), mimeType: p.mediaType, name: p.filename } } as A2APart;
  }
  return { ...(p.raw ? { raw: p.raw } : { url: p.url! }), mediaType: p.mediaType, filename: p.filename };
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The parts and the text note for attachments going to a peer. Throws
 *  when a file can only go as a link and somora has no public address. */
export async function outgoingFiles(
  files: AttachmentRef[],
  card: AgentCard,
  version: ProtocolVersion,
  publicUrl: string | undefined,
): Promise<{ parts: A2APart[]; note: string; inline: number; links: number }> {
  const parts: A2APart[] = [];
  const lines: string[] = [];
  for (const f of files) {
    if (cardAccepts(card, f.mime) && f.size <= MAX_INLINE_BYTES) {
      const r = await resolveAttachmentByHash({ hash: f.hash, expectedMime: f.mime });
      parts.push(filePart(version, { raw: readFileSync(r.path).toString('base64'), mediaType: f.mime, filename: f.name }));
      continue;
    }
    if (!publicUrl) {
      throw new Error(
        `${f.name} can only go as a download link, and somora has no public address for one — set a2a.publicUrl in config.yaml (docs/a2a.md#images-and-files)`,
      );
    }
    lines.push(`- ${f.name} (${f.mime}, ${kb(f.size)}): ${fileLinkUrl(publicUrl, f)}`);
  }
  const note = lines.length > 0 ? `[Files for this task — download links, valid for one hour:\n${lines.join('\n')}]\n\n` : '';
  return { parts, note, inline: parts.length, links: lines.length };
}

// ── incoming ──────────────────────────────────────────────────────────

const isFilePart = (p: A2APart) => typeof p.raw === 'string' || typeof p.url === 'string' || Boolean(p.file?.bytes || p.file?.uri);

/** Base64 characters for `bytes`, with room for line breaks. */
const base64Chars = (bytes: number) => Math.ceil(bytes / 3) * 4 + 1024;

/** The biggest request body an A2A peer may send: five files at the
 *  largest attachment size, as base64, and the longest text (a JSON
 *  escape takes up to six bytes a character), with room for the rest. */
export function maxRequestBytes(a: AttachmentsConfig, maxMessageChars: number): number {
  return MAX_INCOMING_FILES * base64Chars(maxSourceBytes(a)) + maxMessageChars * 6 + 256 * 1024;
}

/** Why the files of an incoming message cannot be taken, judged without
 *  decoding or fetching anything: too many, or bytes beyond the limit. */
export function checkIncomingFiles(parts: A2APart[], a: AttachmentsConfig): string | null {
  const fileParts = parts.filter(isFilePart);
  if (fileParts.length > MAX_INCOMING_FILES) return `at most ${MAX_INCOMING_FILES} files in one message`;
  const max = maxSourceBytes(a);
  for (const p of fileParts) {
    const raw = p.raw ?? p.file?.bytes;
    if (typeof raw === 'string' && raw.length > base64Chars(max)) return `${(p.filename ?? p.file?.name ?? 'file').slice(0, 200)}: the file is larger than ${kb(max)}`;
  }
  return null;
}

/** File parts of an incoming message as somora attachments. */
export async function incomingFiles(
  parts: A2APart[],
  cfg: { attachments: AttachmentsConfig; allowPrivate: readonly string[] },
): Promise<{ files: AttachmentRef[] } | { error: string }> {
  const fileParts = parts.filter(isFilePart);
  if (fileParts.length === 0) return { files: [] };
  const refused = checkIncomingFiles(parts, cfg.attachments);
  if (refused) return { error: refused };
  const files: AttachmentRef[] = [];
  for (const p of fileParts) {
    const name = (p.filename ?? p.file?.name ?? 'file').slice(0, 200);
    let body: Readable;
    try {
      const raw = p.raw ?? p.file?.bytes;
      if (typeof raw === 'string') {
        body = Readable.from(Buffer.from(raw, 'base64'));
      } else {
        body = await fetchFileBody(String(p.url ?? p.file?.uri), cfg.allowPrivate, maxSourceBytes(cfg.attachments));
      }
      const stored = await storeAttachment({ body, name, config: cfg.attachments });
      files.push({ hash: stored.hash, name: stored.name, mime: stored.mime.mimeType, size: stored.size });
    } catch (err) {
      return { error: `${name}: ${(err as Error).message}` };
    }
  }
  return { files };
}

function maxSourceBytes(a: AttachmentsConfig): number {
  return Math.max(a.maxImageBytes * 4, a.maxPdfBytes, a.maxTextBytes);
}

/** GET a peer's file URL with web_fetch's guard: http(s) only, no
 *  internal addresses (unless web.fetchAllowPrivate lists them), a size
 *  cap, no endless redirects. */
async function fetchFileBody(url: string, allowPrivate: readonly string[], maxBytes: number): Promise<Readable> {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    ssrfCheck(current, allowPrivate);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(current.href, { redirect: 'manual', dispatcher: getGuardedAgent(allowPrivate), signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw fetchFailure(err);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`the file URL answered HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new Error(`the file is larger than ${kb(maxBytes)}`);
    let seen = 0;
    const src = Readable.fromWeb(res.body as never);
    return src.map((chunk: Buffer) => {
      seen += chunk.length;
      if (seen > maxBytes) throw new Error(`the file is larger than ${kb(maxBytes)}`);
      return chunk;
    });
  }
  throw new Error('too many redirects');
}

/** File parts for files an answer carries (generated images, videos). */
export function answerFileParts(version: ProtocolVersion, files: Array<{ url: string; mediaType: string; filename: string }>): A2APart[] {
  return files.map((f) => filePart(version, { url: f.url, mediaType: f.mediaType, filename: f.filename }));
}

export function logFiles(msg: string, fields: Record<string, unknown>): void {
  logger.info({ msg, ...fields });
}
