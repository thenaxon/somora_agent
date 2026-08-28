// Shared shapes for generated media — images today, video alongside
// them, and whatever comes next.
//
// One record type rather than one per medium: the questions a caller
// asks ("what did I make, when, with which model, where is the file")
// are identical, and two near-identical types would drift the moment
// one of them gained a field.

export type MediaKind = 'image' | 'video';

/** One generated file, as persisted and as handed back to callers. */
export interface MediaRecord {
  id: string;
  /**
   * Absent on records written before video existed — those are all
   * images, so a missing value reads as `image` rather than as
   * "unknown". Use `mediaKind()` instead of touching this directly.
   */
  kind?: MediaKind;
  /** ISO-8601, local-time offset preserved. */
  createdAt: string;
  prompt: string;
  /** Config handle (`zimage`, `h3`). */
  modelName: string;
  /** Wire id sent to the provider. */
  modelId: string;
  /** providers.<name> the request went through. */
  provider: string;
  /** Whatever spec fields the request carried, as sent. */
  specs: Record<string, unknown>;
  /** Absolute path in the canonical media directory. */
  path: string;
  filename: string;
  mime: string;
  bytes: number;
  /** Real pixel dimensions, read from the bytes. Absent for a format
   *  we can't measure. */
  width?: number;
  height?: number;
  /** Video only: playing time from the file's own header. */
  durationSec?: number;
  /**
   * Video only: a still saved next to the file. Providers that publish
   * one (OpenAI's `variant=thumbnail`, and ours) let a gallery show a
   * frame instead of a black box — and because it is an ordinary
   * image, `analyze_file` reads it, which is how an agent judges a
   * video it just made without anyone shipping a video decoder.
   */
  thumbPath?: string;
  thumbMime?: string;
  /** Additional locations the caller asked for, as hardlinks (or
   *  copies, across filesystems). */
  linkedTo: string[];
  /** Upstream-reported cost in USD, when available. */
  costUsd?: number;
  /** Who triggered it — agent name, or undefined for a UI request. */
  agent?: string;
  session?: string;
  /** Number of reference images passed in. */
  references?: number;
  /** Groups the outputs of one call. */
  batchId: string;
  batchIndex: number;
}

/** A record's medium, treating the pre-video absence as `image`. */
export function mediaKind(record: Pick<MediaRecord, 'kind'>): MediaKind {
  return record.kind ?? 'image';
}
