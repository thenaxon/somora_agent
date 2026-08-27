// Turning what a caller supplied into reference-image bytes.
//
// The two entrances legitimately differ and that is not an accident:
// an agent names a PATH (it works on the same machine, and base64 in a
// tool argument would mean loading the file into its context just to
// send it straight back out), while the browser has BYTES for a file
// the user picked and no server-side path for it at all. Both end up
// in the same ReferenceImage shape.
//
// Path resolution and the read policy deliberately live in the tool
// layer, not here — deciding WHICH files an agent may open needs the
// agent's identity, and this module has no business knowing it.

import { Buffer } from 'node:buffer';
import { detectMimeFromBuffer } from '../multimodal/mime.ts';
import { ImageGenError } from './generate.ts';
import type { ReferenceImage } from './generate.ts';

/** Formats an image endpoint will accept as a reference. SVG is absent
 *  on purpose: magic bytes can't identify it and no image backend we
 *  target takes it as an input reference. */
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Build a reference from bytes already in hand. `label` is only used to
 * name the multipart part and to make an error message point at
 * something the caller recognises.
 *
 * The MIME comes from the bytes, never from the filename: a
 * `reference.png` that is really a JPEG would otherwise be announced
 * wrongly to the endpoint, and the failure surfaces as a confusing
 * upstream 400 rather than as the local mistake it is.
 */
export function referenceFromBytes(bytes: Buffer, label: string): ReferenceImage {
  if (bytes.length === 0) {
    throw new ImageGenError(`Reference image '${label}' is empty.`, 'input');
  }
  const detected = detectMimeFromBuffer(bytes);
  if (!ACCEPTED.has(detected.mimeType)) {
    throw new ImageGenError(
      `Reference image '${label}' is ${detected.mimeType || 'of an unrecognised type'} — ` +
        `references must be PNG, JPEG, WebP or GIF.`,
      'input',
    );
  }
  // Give the part an extension matching what the bytes actually are,
  // since some backends key format handling off the filename.
  const stem = label.replace(/\.[^./\\]+$/, '').split(/[/\\]/).pop() || 'reference';
  return {
    bytes,
    mime: detected.mimeType,
    filename: `${stem}.${EXT_BY_MIME[detected.mimeType]}`,
  };
}

/** Build a reference from a base64 string, with or without a
 *  `data:image/png;base64,` prefix — browsers produce both. */
export function referenceFromBase64(value: string, index: number): ReferenceImage {
  const comma = value.indexOf(',');
  const bare = value.startsWith('data:') && comma > 0 ? value.slice(comma + 1) : value;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(bare, 'base64');
  } catch {
    throw new ImageGenError(`Reference image #${index + 1} is not valid base64.`, 'input');
  }
  return referenceFromBytes(bytes, `reference-${index + 1}`);
}
