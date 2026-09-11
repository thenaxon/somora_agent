// Hand a picture to another agent.
//
// An agent has file PATHS, not upload hashes: `image_generate` returns
// a path, the browser's screenshot returns a path, a file listing
// returns paths. Until 2026-09-11 there was no way to get any of them
// into another agent's turn — `agent_ask` and `spawn_subagent` carried
// text only, so an orchestrator handing a graphic to a co-worker could
// only mention where it lies, and a path is just text to a model that
// can see. Rene, on whether agents need this: "es könnte schon
// passieren das ein agent im A2A ein bild einem anderen agenten
// schickt zum weiterverarbeiten … besonders bei grösseren tasks wo
// einer der orchestrator war".
//
// The bytes travel the same route a browser client uses: POST
// /attachments (raw body, name in a header), then the returned ref on
// the send. Going through the server rather than reading the file here
// is what makes this work from an MCP tool child too, which has no
// attachment store of its own.

import { createReadStream, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { loopbackFetch } from '../../server/loopback-fetch.ts';

/** The ref shape POST /attachments returns and the send routes take. */
export interface AttachmentRef {
  hash: string;
  name: string;
  mime: string;
  kind: string;
  size: number;
}

/** Same cap as a chat turn's attachments — `config.attachments.maxPerTurn`
 *  is enforced server-side; this one keeps a bad loop from uploading
 *  fifty files before the turn is refused. */
export const MAX_IMAGES_PER_MESSAGE = 8;

export const IMAGES_FIELD_DESCRIPTION =
  'Absolute paths of images (or PDFs) to attach to this message, e.g. a picture you just ' +
  'generated. The target agent SEES them; a target whose model has no vision gets the ' +
  "vision worker's description instead. Use this instead of naming a path in the text — a " +
  'path is just text to a model. Max ' +
  MAX_IMAGES_PER_MESSAGE +
  ' per message.';

/**
 * Upload local files and return their refs, in the given order.
 *
 * Throws with a message the model can act on: a wrong path, a
 * directory, an empty file or a server-side refusal (size caps, unknown
 * type) are all things it can fix by passing a different path.
 */
export async function uploadLocalAttachments(
  paths: readonly string[],
  base: string,
): Promise<AttachmentRef[]> {
  if (paths.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(
      `${paths.length} images exceed the per-message cap of ${MAX_IMAGES_PER_MESSAGE} — send fewer, or send them in several messages`,
    );
  }
  const refs: AttachmentRef[] = [];
  for (const p of paths) {
    if (!isAbsolute(p)) {
      throw new Error(`image path must be absolute: ${p}`);
    }
    let size: number;
    try {
      const st = statSync(p);
      if (st.isDirectory()) throw new Error('is a directory');
      size = st.size;
    } catch (err) {
      throw new Error(`cannot read image ${p}: ${(err as Error).message}`);
    }
    if (size === 0) throw new Error(`image ${p} is empty`);
    const res = await loopbackFetch(`${base}/attachments`, {
      method: 'POST',
      headers: {
        // The store sniffs magic bytes anyway — extensions lie — so an
        // honest generic type here beats a guess from the suffix.
        'Content-Type': 'application/octet-stream',
        'X-Somora-Filename': encodeURIComponent(basename(p)),
      },
      // Node's fetch needs duplex for a streamed body; the file never
      // sits in memory as one buffer.
      body: Readable.toWeb(createReadStream(p)) as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let msg = detail.slice(0, 300);
      try {
        const parsed = JSON.parse(detail) as { error?: string };
        if (parsed.error) msg = parsed.error;
      } catch {
        /* not JSON, keep raw */
      }
      throw new Error(`upload of ${p} failed (HTTP ${res.status}): ${msg}`);
    }
    refs.push((await res.json()) as AttachmentRef);
  }
  return refs;
}
