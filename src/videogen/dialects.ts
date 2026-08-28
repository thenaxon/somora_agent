// The three shapes a video endpoint speaks.
//
// Every provider does the same three things — start a render, ask
// whether it is done, fetch the result — and every provider spells them
// differently. Isolating the spelling here is what keeps the rest of
// the video code provider-neutral; nothing outside this file knows
// where a job id lives or what a status field is called.
//
//   openai       POST /videos                        → id in the body
//                GET  /videos/{id}                     id in the PATH
//                GET  /videos/{id}/content?variant=…
//                Verified against the published API shape; the variants
//                (video | thumbnail | spritesheet) are OpenAI's, and
//                the reason somora asks for thumbnails at all.
//
//   passthrough  POST /vid/create                    → id in the body
//                GET  /vid/status?id=…                 id in the QUERY
//                GET  /vid/content?id=…&variant=…
//                The shape that survives a proxy which forwards exact
//                paths but not wildcards — which is how a router in
//                front of a local backend ends up here. Verified live
//                on 2026-08-28, full lifecycle including thumbnails.
//
//   veo          POST …:predictLongRunning           → OPERATION NAME
//                POST …:fetchPredictOperation          (not a GET)
//                result arrives IN the poll response, as a GCS URI or
//                inline bytes — there is no content endpoint at all.
//
// ⚠ `veo` is written from Google's published shape and has NOT been
// run against a live endpoint — somora has had no Vertex access. It is
// a prepared seam so that adding Veo is a config entry rather than a
// refactor. Do not describe it as working until someone has watched it
// work; every other dialect here was measured first.

import { Buffer } from 'node:buffer';
import type { VideoWire } from '../config/types.ts';

export type VideoJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

/** What `create` yields: the handle everything else is keyed by. */
export interface CreatedJob {
  id: string;
  /** Anything else the provider volunteered — seed, echoed params,
   *  ignored_params — kept whole so callers can report it. */
  raw: Record<string, unknown>;
}

export interface JobState {
  status: VideoJobStatus;
  /** 0–100 where the provider reports it. */
  progress?: number;
  queuePosition?: number;
  /** Set when `status` is `failed`. */
  error?: string;
  /**
   * Set by dialects that deliver the result in the poll response
   * instead of from a content endpoint (Veo). When present, the
   * downloader uses it and never calls `contentUrl`.
   */
  resultUrl?: string;
  resultBase64?: string;
  raw: Record<string, unknown>;
}

export interface HttpCall {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: BodyInit;
}

/** Content flavours. `video` is the file; `thumbnail` is a still, which
 *  is what lets a gallery show a frame and an agent read its own output
 *  with analyze_file. */
export type ContentVariant = 'video' | 'thumbnail';

export interface DialectEndpoints {
  create: string;
  status: string;
  content: string;
}

/** Path defaults per dialect. An operator can override any of them. */
export const DEFAULT_ENDPOINTS: Record<VideoWire, DialectEndpoints> = {
  openai: { create: '/videos', status: '/videos', content: '/videos' },
  passthrough: { create: '/vid/create', status: '/vid/status', content: '/vid/content' },
  // Vertex puts the model in the path and the verb after a colon, so
  // these are suffixes appended to a per-model base rather than fixed
  // paths. See the note at the top of the file.
  veo: { create: ':predictLongRunning', status: ':fetchPredictOperation', content: '' },
};

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Providers disagree on where a failure message lives. Look in the
 *  places they actually use rather than picking one and hoping. */
export function errorMessage(raw: Record<string, unknown>): string | undefined {
  const err = raw.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = str((err as Record<string, unknown>).message);
    if (m) return m;
  }
  const detail = raw.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') {
    const m = str((detail as Record<string, unknown>).message);
    if (m) return m;
  }
  return undefined;
}

function normaliseStatus(v: unknown): VideoJobStatus {
  const s = String(v ?? '').toLowerCase();
  if (s === 'completed' || s === 'succeeded' || s === 'success') return 'completed';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'expired') return 'failed';
  if (s === 'in_progress' || s === 'running' || s === 'processing') return 'in_progress';
  return 'queued';
}

export interface Dialect {
  /** Where a create request goes, given the resolved base + endpoints. */
  createUrl(base: string, ep: DialectEndpoints, model: string): string;
  /** Reads the id out of a create response. */
  parseCreate(payload: Record<string, unknown>): CreatedJob;
  statusCall(base: string, ep: DialectEndpoints, id: string, model: string): HttpCall;
  parseStatus(payload: Record<string, unknown>): JobState;
  /** Null when this dialect delivers the result in the poll response. */
  contentUrl(base: string, ep: DialectEndpoints, id: string, variant: ContentVariant): string | null;
}

const openai: Dialect = {
  createUrl: (base, ep) => trimBase(base) + ep.create,
  parseCreate: (p) => ({ id: String(p.id ?? ''), raw: p }),
  statusCall: (base, ep, id) => ({
    url: `${trimBase(base)}${ep.status}/${encodeURIComponent(id)}`,
    method: 'GET',
    headers: {},
  }),
  parseStatus: (p) => ({
    status: normaliseStatus(p.status),
    progress: num(p.progress),
    error: errorMessage(p),
    raw: p,
  }),
  contentUrl: (base, ep, id, variant) =>
    `${trimBase(base)}${ep.content}/${encodeURIComponent(id)}/content?variant=${variant}`,
};

const passthrough: Dialect = {
  createUrl: (base, ep) => trimBase(base) + ep.create,
  parseCreate: (p) => ({ id: String(p.id ?? ''), raw: p }),
  statusCall: (base, ep, id) => ({
    url: `${trimBase(base)}${ep.status}?id=${encodeURIComponent(id)}`,
    method: 'GET',
    headers: {},
  }),
  parseStatus: (p) => ({
    status: normaliseStatus(p.status),
    progress: num(p.progress),
    queuePosition: num(p.queue_position),
    error: errorMessage(p),
    raw: p,
  }),
  contentUrl: (base, ep, id, variant) =>
    `${trimBase(base)}${ep.content}?id=${encodeURIComponent(id)}&variant=${variant}`,
};

const veo: Dialect = {
  // Vertex addresses the model in the path: <base>/models/<model>:verb
  createUrl: (base, ep, model) => `${trimBase(base)}/models/${model}${ep.create}`,
  // The handle is an operation NAME, not an id — long, slash-separated,
  // and the thing every later call is keyed by.
  parseCreate: (p) => ({ id: String(p.name ?? p.operationName ?? ''), raw: p }),
  statusCall: (base, ep, id, model) => ({
    // Polling is a POST carrying the operation name, not a GET on it.
    url: `${trimBase(base)}/models/${model}${ep.status}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: id }),
  }),
  parseStatus: (p) => {
    const done = p.done === true;
    const err = p.error as Record<string, unknown> | undefined;
    if (err) return { status: 'failed', error: errorMessage(p), raw: p };
    if (!done) return { status: 'in_progress', raw: p };
    // The finished video sits in the operation's response, either as a
    // storage URI or inline — there is no content endpoint to call.
    const resp = (p.response ?? {}) as Record<string, unknown>;
    const videos = Array.isArray(resp.videos) ? (resp.videos as Record<string, unknown>[]) : [];
    const first = videos[0] ?? {};
    return {
      status: 'completed',
      resultUrl: str(first.gcsUri) ?? str(first.uri) ?? str(resp.gcsUri),
      resultBase64: str(first.bytesBase64Encoded) ?? str(first.videoBytes),
      raw: p,
    };
  },
  // Nothing to fetch by id: parseStatus already carries the result.
  contentUrl: () => null,
};

const DIALECTS: Record<VideoWire, Dialect> = { openai, passthrough, veo };

export function dialectFor(wire: VideoWire): Dialect {
  return DIALECTS[wire];
}

/** Decode a base64 payload that may or may not carry a data: prefix. */
export function decodeBase64(value: string): Buffer {
  const comma = value.indexOf(',');
  return Buffer.from(value.startsWith('data:') && comma > 0 ? value.slice(comma + 1) : value, 'base64');
}
