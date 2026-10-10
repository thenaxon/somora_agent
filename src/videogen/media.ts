// Input media for a video render: what each file IS, and how it goes on
// the wire (docs/videogen.md, "Media inputs").
//
// somora describes inputs by meaning — opening frame, closing frame,
// reference image, reference video, input video, character image,
// keyframe at a time, reference audio — and never by a provider's field
// name. Which field a type becomes is decided per model, in this order:
//
//   1. the model's `media` block in config.yaml — the operator's word,
//      for a provider that names a field differently or has no catalog;
//      without a catalog it is the model's complete list
//   2. the provider catalog's `accepted_media` — the model's own word;
//      when it is published, types it does not list are not accepted
//   3. the dialect's published format: `openai` takes one opening frame
//      as `input_reference`; `veo` takes `image`, `lastFrame` and up to
//      three `referenceImages`; `passthrough` keeps the field names it
//      has always used (`first_frame`, `last_frame`, `image[]`)
//
// A type nothing maps is refused before the request goes out, with the
// way to map it. So is a count, kind or length the model does not take.
// Files travel as multipart parts or, with `transport: json`, as `data:`
// URIs inside the JSON body; a local path never leaves this machine.

import { Buffer } from 'node:buffer';
import type { VideoMediaField, VideoMediaType, VideoModel, VideoWire } from '../config/types.ts';
import type { ModelCapabilities } from '../imagegen/types.ts';
import { detectMimeFromBuffer } from '../multimodal/mime.ts';
import { readVideoMeta } from '../multimodal/dimensions.ts';

export type MediaKind = 'image' | 'video' | 'audio';

/** The kind of file each type takes. */
export const MEDIA_KIND: Record<VideoMediaType, MediaKind> = {
  first_frame: 'image',
  last_frame: 'image',
  reference_image: 'image',
  reference_video: 'video',
  input_video: 'video',
  character_image: 'image',
  keyframe_image: 'image',
  keyframe_video: 'video',
  reference_audio: 'audio',
};

export const MEDIA_TYPES = Object.keys(MEDIA_KIND) as VideoMediaType[];

/** One input file, already read and checked by the caller. */
export interface MediaItem {
  type: VideoMediaType;
  bytes: Buffer;
  /** Sniffed from the bytes, never from the name. */
  mime: string;
  filename: string;
  /** Keyframes only: where in the video, in seconds. */
  seconds?: number;
  strength?: number;
  /** Length of a video, when it can be read from the file. */
  durationSec?: number;
}

/** Largest input file somora reads for a render. Providers set their
 *  own, lower limits (a data: URI grows by a third); this one only keeps
 *  a stray multi-gigabyte path from being loaded into memory. */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

/**
 * An input file from bytes already in hand. The type comes from the
 * caller, the MIME from the bytes (never the name), and a video's length
 * from its header where it has one. Throws with the label in the message
 * for an empty, too large or unrecognised file.
 */
export function mediaItemFromBytes(
  type: VideoMediaType,
  bytes: Buffer,
  label: string,
  extra: { seconds?: number; strength?: number } = {},
): MediaItem {
  if (bytes.length === 0) throw new Error(`media file '${label}' is empty.`);
  if (bytes.length > MAX_MEDIA_BYTES) {
    throw new Error(`media file '${label}' is ${(bytes.length / 1048576).toFixed(0)} MB; somora sends at most ${MAX_MEDIA_BYTES / 1048576} MB per file.`);
  }
  const mime = detectMimeFromBuffer(bytes).mimeType;
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    throw new Error(
      `media file '${label}' is ${mime === 'application/octet-stream' ? 'of an unrecognised type' : mime} — images must be PNG, JPEG, WebP or GIF, videos MP4, MOV or WebM, audio WAV, MP3, M4A, OGG or FLAC.`,
    );
  }
  const stem = label.replace(/\.[^./\\]+$/, '').split(/[/\\]/).pop() || type;
  const meta = mime.startsWith('video/') ? readVideoMeta(bytes) : null;
  return {
    type,
    bytes,
    mime,
    filename: `${stem}.${ext}`,
    ...(meta?.durationSec ? { durationSec: meta.durationSec } : {}),
    ...(extra.seconds !== undefined ? { seconds: extra.seconds } : {}),
    ...(extra.strength !== undefined ? { strength: extra.strength } : {}),
  };
}

/** How one type goes on the wire for this model, and where that came
 *  from — the source decides the wording of a refusal. */
export interface MediaSlot extends VideoMediaField {
  source: 'config' | 'catalog' | 'dialect';
}

/** The dialects' published formats. `passthrough` is somora's own
 *  long-standing convention, kept byte for byte (see legacyPassthrough). */
const DIALECT_SLOTS: Record<VideoWire, Partial<Record<VideoMediaType, VideoMediaField>>> = {
  openai: { first_frame: { field: 'input_reference', max: 1 } },
  passthrough: {
    first_frame: { field: 'first_frame', max: 1 },
    last_frame: { field: 'last_frame', max: 1 },
    reference_image: { field: 'image[]', max: 4 },
  },
  veo: {
    first_frame: { field: 'image', max: 1 },
    last_frame: { field: 'lastFrame', max: 1 },
    reference_image: { field: 'referenceImages', max: 3 },
  },
};

/** The slots a model offers: config over catalog over dialect. */
export function mediaSlots(
  entry: Pick<VideoModel, 'wire' | 'media'>,
  caps: Pick<ModelCapabilities, 'media'>,
): Partial<Record<VideoMediaType, MediaSlot>> {
  const dialect = DIALECT_SLOTS[entry.wire];
  const slots: Partial<Record<VideoMediaType, MediaSlot>> = {};
  if (caps.media) {
    // A published list is the model's truth: what it leaves out, it does
    // not take, whatever the dialect would offer.
    for (const [type, m] of Object.entries(caps.media)) {
      if (!(MEDIA_TYPES as string[]).includes(type)) continue;
      const t = type as VideoMediaType;
      const preferred = dialect[t]?.field;
      const field = m.fields?.includes(preferred ?? '') ? preferred! : (m.fields?.[0] ?? preferred);
      if (!field) continue;
      slots[t] = {
        field,
        ...(m.max !== undefined ? { max: m.max } : {}),
        ...(m.min !== undefined ? { min: m.min } : {}),
        ...(m.maxSeconds !== undefined ? { maxSeconds: m.maxSeconds } : {}),
        source: 'catalog',
      };
    }
  } else if (!entry.media) {
    for (const [type, f] of Object.entries(dialect)) slots[type as VideoMediaType] = { ...f, source: 'dialect' };
  }
  // Over a catalog, a config entry renames or adds one type. Without a
  // catalog, the config block is the model's whole list: a model declared
  // to take a video and a character image does not also take the
  // dialect's opening frame.
  for (const [type, f] of Object.entries(entry.media ?? {})) {
    slots[type as VideoMediaType] = { ...f, source: 'config' };
  }
  return slots;
}

/** What a client shows about a model's inputs: per type the kind of
 *  file, how many, how many are needed, how long. */
export interface MediaSummary {
  kind: MediaKind;
  max?: number;
  min?: number;
  max_seconds?: number;
}

export function describeSlots(slots: Partial<Record<VideoMediaType, MediaSlot>>): Partial<Record<VideoMediaType, MediaSummary>> {
  const out: Partial<Record<VideoMediaType, MediaSummary>> = {};
  for (const [type, slot] of Object.entries(slots) as [VideoMediaType, MediaSlot][]) {
    out[type] = {
      kind: MEDIA_KIND[type],
      ...(slot.max !== undefined ? { max: slot.max } : {}),
      ...(slot.min ? { min: slot.min } : {}),
      ...(slot.maxSeconds !== undefined ? { max_seconds: slot.maxSeconds } : {}),
    };
  }
  return out;
}

/** `reference_images` in media terms — the meaning the tool has always
 *  documented: one is the opening frame, two are opening and closing
 *  frame, more are reference images. */
export function mediaFromReferences(refs: Array<{ bytes: Buffer; mime: string; filename: string }>): MediaItem[] {
  if (refs.length === 1) return [{ type: 'first_frame', ...refs[0]! }];
  if (refs.length === 2) return [
    { type: 'first_frame', ...refs[0]! },
    { type: 'last_frame', ...refs[1]! },
  ];
  return refs.map((r) => ({ type: 'reference_image' as const, ...r }));
}

function kindOf(mime: string): MediaKind | 'other' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

/** "an image", "a video", "an audio file". */
function article(kind: MediaKind): string {
  return kind === 'image' ? 'an image' : kind === 'audio' ? 'an audio file' : 'a video';
}

function listTypes(slots: Partial<Record<VideoMediaType, MediaSlot>>): string {
  const t = Object.keys(slots);
  return t.length > 0 ? t.join(', ') : 'no input files';
}

export interface MediaCheck {
  slots: Partial<Record<VideoMediaType, MediaSlot>>;
  problems: string[];
}

/**
 * Everything that can be decided before the request goes out. Each
 * problem says what to change, because the reader is usually a model
 * that retries with whatever the message suggests.
 */
export function checkMedia(
  items: MediaItem[],
  entry: Pick<VideoModel, 'wire' | 'media' | 'fps' | 'transport'>,
  caps: Pick<ModelCapabilities, 'media' | 'fps'>,
  label: string,
): MediaCheck {
  const slots = mediaSlots(entry, caps);
  const problems: string[] = [];
  const counts = new Map<VideoMediaType, number>();
  for (const it of items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);

  for (const [type, n] of counts) {
    const slot = slots[type];
    if (!slot) {
      problems.push(
        `${label} takes no ${type} — it takes ${listTypes(slots)}.` +
          (caps.media
            ? ''
            : ` If your provider does take it, name its field under videoGen.models[].media.${type}.field in config.yaml.`),
      );
      continue;
    }
    if (slot.max !== undefined && n > slot.max) {
      problems.push(
        slot.max === 0
          ? `${label} takes no ${type}.`
          : `${n} × ${type} passed, but ${label} takes at most ${slot.max}.`,
      );
    }
  }
  for (const [type, slot] of Object.entries(slots) as [VideoMediaType, MediaSlot][]) {
    if (slot.min && (counts.get(type) ?? 0) < slot.min) {
      problems.push(`${label} needs ${slot.min} × ${type} (${MEDIA_KIND[type]}) — add it under media.`);
    }
  }

  const fps = entry.fps ?? caps.fps;
  for (const it of items) {
    const want = MEDIA_KIND[it.type];
    const got = kindOf(it.mime);
    if (got !== want) {
      problems.push(`${it.filename} is ${got === 'other' ? it.mime : article(got)}, but ${it.type} takes ${article(want)}.`);
    }
    const slot = slots[it.type];
    if (slot?.maxSeconds !== undefined && it.durationSec !== undefined && it.durationSec > slot.maxSeconds) {
      problems.push(
        `${it.filename} runs ${it.durationSec.toFixed(1)} s, but ${label} takes at most ${slot.maxSeconds} s for ${it.type}.`,
      );
    }
    const keyframe = it.type === 'keyframe_image' || it.type === 'keyframe_video';
    if (keyframe) {
      if (it.seconds === undefined) problems.push(`${it.type} ${it.filename} needs seconds: where in the video it belongs.`);
      if (slot && entry.wire !== 'veo') {
        if (!slot.item) {
          problems.push(
            `${label} has no keyframe format configured for ${it.type}: set videoGen.models[].media.${it.type}.item (url and seconds or frame) in config.yaml.`,
          );
        } else if (slot.item.frame && !slot.item.seconds && fps === undefined) {
          // Seconds in, and a refusal rather than a guessed frame rate.
          problems.push(
            `${label} takes keyframes as frame numbers, and its frame rate is unknown — set videoGen.models[].fps, or have the catalog publish fps.`,
          );
        }
      }
    } else {
      if (it.seconds !== undefined) problems.push(`seconds belongs to keyframes only, not to ${it.type}.`);
      if (it.strength !== undefined && !slot?.item?.strength) {
        problems.push(`strength is not something ${label} takes for ${it.type}.`);
      }
    }
  }

  if (entry.wire === 'veo' && items.some((it) => it.type === 'keyframe_image' || it.type === 'keyframe_video')) {
    problems.push(`${label} speaks Veo's format, which has no keyframes.`);
  }
  if (entry.wire === 'passthrough' && usesLegacyPassthrough(items, slots)) {
    const types = new Set(items.map((i) => i.type));
    if (types.has('reference_image') && (types.has('first_frame') || types.has('last_frame'))) {
      problems.push(
        `${label} cannot be told which file is a frame and which a reference without field names: send frames or references, or configure videoGen.models[].media.`,
      );
    }
    if (types.has('last_frame') && !types.has('first_frame')) {
      problems.push(`a last_frame needs a first_frame with it on ${label}.`);
    }
  }
  const transport = entry.transport ?? 'multipart';
  if (entry.wire !== 'veo' && transport === 'multipart') {
    for (const it of items) {
      if (slots[it.type]?.item) {
        problems.push(`${it.type} with an item format needs transport: json for ${label}.`);
        break;
      }
    }
  }
  return { slots, problems };
}

/** True when every file in the request uses a slot the passthrough
 *  dialect supplied itself — then the old field rules apply unchanged. */
function usesLegacyPassthrough(items: MediaItem[], slots: Partial<Record<VideoMediaType, MediaSlot>>): boolean {
  return items.length > 0 && items.every((it) => slots[it.type]?.source === 'dialect');
}

function blobOf(it: MediaItem): Blob {
  return new Blob([new Uint8Array(it.bytes)], { type: it.mime });
}

function dataUri(it: MediaItem): string {
  return `data:${it.mime};base64,${it.bytes.toString('base64')}`;
}

/** Set `value` at a dotted path in `obj`, creating objects on the way. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** OpenAI's create takes `seconds` as a string ("4", "8", "12"). */
function publishedSpecs(wire: VideoWire, specs: Record<string, unknown>): Record<string, unknown> {
  if (wire !== 'openai' || typeof specs.seconds !== 'number') return specs;
  return { ...specs, seconds: String(specs.seconds) };
}

/** Veo's request parameters are camelCase; the tool's names map onto
 *  them, anything else goes through as the caller wrote it. */
const VEO_PARAMS: Record<string, string> = {
  seconds: 'durationSeconds',
  aspect_ratio: 'aspectRatio',
  audio: 'generateAudio',
  negative_prompt: 'negativePrompt',
  person_generation: 'personGeneration',
  sample_count: 'sampleCount',
  enhance_prompt: 'enhancePrompt',
  storage_uri: 'storageUri',
};

export interface CreateBody {
  body: BodyInit;
  /** Set for JSON; multipart sets its own boundary. */
  contentType?: string;
}

/**
 * The create request's body. With no input files it is the JSON body
 * somora has always sent (for `veo`, Google's instances/parameters).
 */
export function buildCreateBody(args: {
  wire: VideoWire;
  model: string;
  prompt: string;
  specs: Record<string, unknown>;
  items: MediaItem[];
  slots: Partial<Record<VideoMediaType, MediaSlot>>;
  transport?: 'multipart' | 'json';
  fps?: number;
}): CreateBody {
  const { wire, model, prompt, slots } = args;
  const specs = publishedSpecs(wire, args.specs);
  // By type, in the order of MEDIA_TYPES, keeping the caller's order
  // within a type: an opening frame always precedes the closing one.
  const items = [...args.items].sort((a, b) => MEDIA_TYPES.indexOf(a.type) - MEDIA_TYPES.indexOf(b.type));

  if (wire === 'veo') return veoBody(prompt, specs, items, slots);

  const transport = args.transport ?? 'multipart';
  if (items.length === 0) {
    return { body: JSON.stringify({ model, prompt, ...specs }), contentType: 'application/json' };
  }

  if (transport === 'multipart') {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    for (const [k, v] of Object.entries(specs)) {
      if (v !== undefined) form.append(k, String(v));
    }
    if (wire === 'passthrough' && usesLegacyPassthrough(items, slots)) {
      // somora's long-standing passthrough convention, byte for byte:
      // two files are named first_frame and last_frame — the endpoint
      // must be told WHICH is which, not left to array order — and any
      // other count goes as image[] parts in order.
      const pair = items.length === 2 && items[0]!.type === 'first_frame' && items[1]!.type === 'last_frame';
      if (pair) {
        form.append('first_frame', blobOf(items[0]!), items[0]!.filename);
        form.append('last_frame', blobOf(items[1]!), items[1]!.filename);
      } else {
        for (const it of items) form.append('image[]', blobOf(it), it.filename);
      }
      return { body: form };
    }
    for (const it of items) form.append(slots[it.type]!.field, blobOf(it), it.filename);
    return { body: form };
  }

  const body: Record<string, unknown> = { model, prompt, ...specs };
  const byField = new Map<string, MediaItem[]>();
  for (const it of items) {
    const f = slots[it.type]!.field;
    byField.set(f, [...(byField.get(f) ?? []), it]);
  }
  for (const [field, list] of byField) {
    const slot = slots[list[0]!.type]!;
    if (slot.item) {
      const objs = list.map((it) => keyframeObject(it, slot, args.fps));
      const existing = getPath(body, field);
      setPath(body, field, [...(Array.isArray(existing) ? existing : []), ...objs]);
      continue;
    }
    const many = list.length > 1 || slot.array === true || (slot.max ?? 1) > 1;
    setPath(body, field, many ? list.map(dataUri) : dataUri(list[0]!));
  }
  return { body: JSON.stringify(body), contentType: 'application/json' };
}

function keyframeObject(it: MediaItem, slot: MediaSlot, fps?: number): Record<string, unknown> {
  const item = slot.item!;
  const o: Record<string, unknown> = { [item.url]: dataUri(it) };
  if (item.seconds) o[item.seconds] = it.seconds;
  else if (item.frame && fps !== undefined && it.seconds !== undefined) o[item.frame] = Math.round(it.seconds * fps);
  if (item.strength && it.strength !== undefined) o[item.strength] = it.strength;
  return o;
}

/** Google's predictLongRunning body (Vertex and the Gemini API):
 *  `{instances: [{prompt, image, lastFrame, referenceImages}], parameters}`.
 *  Images go as `{bytesBase64Encoded, mimeType}`. Not yet run against a
 *  live endpoint — see dialects.ts. */
function veoBody(
  prompt: string,
  specs: Record<string, unknown>,
  items: MediaItem[],
  slots: Partial<Record<VideoMediaType, MediaSlot>>,
): CreateBody {
  const instance: Record<string, unknown> = { prompt };
  const image = (it: MediaItem) => ({ bytesBase64Encoded: it.bytes.toString('base64'), mimeType: it.mime });
  for (const it of items) {
    const field = slots[it.type]!.field;
    if (field === 'referenceImages') {
      const list = (instance.referenceImages as unknown[] | undefined) ?? [];
      instance.referenceImages = [...list, { image: image(it), referenceType: 'asset' }];
    } else if (it.type === 'keyframe_image' || it.type === 'keyframe_video') {
      continue; // refused by checkMedia; Veo publishes no keyframes
    } else {
      const slot = slots[it.type]!;
      const many = slot.array === true || (slot.max ?? 1) > 1;
      if (many) instance[field] = [...((instance[field] as unknown[] | undefined) ?? []), image(it)];
      else instance[field] = image(it);
    }
  }
  const parameters: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(specs)) {
    if (v !== undefined) parameters[VEO_PARAMS[k] ?? k] = v;
  }
  return {
    body: JSON.stringify({ instances: [instance], ...(Object.keys(parameters).length > 0 ? { parameters } : {}) }),
    contentType: 'application/json',
  };
}
