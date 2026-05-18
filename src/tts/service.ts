// TTS synthesizer service.
//
// Three responsibilities:
//   1. Content-negotiate the wire format (WAV passthrough vs ffmpeg
//      re-encode to opus/m4a) based on the client's `Accept` header
//      and config.tts.reencode.enabled.
//   2. Synthesize via the configured OpenAI-compatible upstream
//      (`POST <provider.baseUrl>/v1/audio/speech` with `{model, input,
//      voice?, language?}`).
//   3. Cache result on disk content-addressed by
//      `sha256(text + voice + model + format)`. Subsequent identical
//      requests stream from the cache without hitting the upstream.
//
// All cache state lives in ~/.somora/tts-cache/. The GC sweeper in
// ./cache-gc.ts handles retention + size cap.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';
import type { Config, TtsConfig } from '../config/types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
export const TTS_CACHE_DIR = join(SOMORA_HOME, 'tts-cache');

function ensureCacheDir(): void {
  if (!existsSync(TTS_CACHE_DIR)) mkdirSync(TTS_CACHE_DIR, { recursive: true });
}

// ── Format negotiation ────────────────────────────────────────────────

export type Format = 'wav' | 'opus' | 'mp4';

interface FormatSpec {
  fmt: Format;
  mime: string;
  ext: string;
}

const FORMATS: Record<Format, FormatSpec> = {
  wav: { fmt: 'wav', mime: 'audio/wav', ext: 'wav' },
  opus: { fmt: 'opus', mime: 'audio/opus', ext: 'opus' },
  mp4: { fmt: 'mp4', mime: 'audio/mp4', ext: 'm4a' },
};

/**
 * Pick the best wire format given the client's Accept header and
 * whether re-encoding is enabled. Priority:
 *
 *   1. If Accept lists `audio/opus` (any q) AND reencode is on → opus
 *      (smallest, mobile-friendly).
 *   2. Else if Accept lists `audio/mp4` AND reencode is on → m4a.
 *   3. Else WAV (upstream passthrough).
 *
 * No Accept header / `*\/*` / `audio/*` ⇒ WAV (safest, always works).
 */
export function negotiateFormat(acceptHeader: string | undefined | null, reencodeEnabled: boolean): FormatSpec {
  if (!reencodeEnabled || !acceptHeader) return FORMATS.wav;
  const lower = acceptHeader.toLowerCase();
  if (lower.includes('audio/opus')) return FORMATS.opus;
  if (lower.includes('audio/mp4') || lower.includes('audio/m4a') || lower.includes('audio/aac')) {
    return FORMATS.mp4;
  }
  return FORMATS.wav;
}

// ── Cache key ─────────────────────────────────────────────────────────

export function computeCacheKey(text: string, voice: string | undefined, model: string, fmt: Format): string {
  const h = createHash('sha256');
  h.update(text);
  h.update('\0');
  h.update(voice ?? '');
  h.update('\0');
  h.update(model);
  h.update('\0');
  h.update(fmt);
  return h.digest('hex');
}

export function cachePath(cacheKey: string, fmt: Format): string {
  return join(TTS_CACHE_DIR, `${cacheKey}.${FORMATS[fmt].ext}`);
}

// ── ffmpeg re-encode ──────────────────────────────────────────────────

async function ffmpegReencode(
  inputBytes: Buffer,
  target: Format,
  opusBitrateKbps: number,
): Promise<Buffer> {
  // Pipe WAV in over stdin, target codec out over stdout. No temp
  // files. Stderr goes to a buffer for error reporting.
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0'];
  if (target === 'opus') {
    args.push('-c:a', 'libopus', '-b:a', `${opusBitrateKbps}k`, '-vbr', 'on', '-f', 'ogg', 'pipe:1');
  } else if (target === 'mp4') {
    // libfdk_aac is best-quality but often not available; aac is the
    // built-in encoder, fine for spoken audio at default bitrate.
    args.push('-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1');
  } else {
    return inputBytes; // wav passthrough — shouldn't be called
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    proc.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`));
      }
      resolve(Buffer.concat(out) as Buffer);
    });
    proc.stdin.end(inputBytes);
  });
}

// ── Synthesizer ───────────────────────────────────────────────────────

export interface SynthesizeInput {
  text: string;
  voice?: string;
  language?: string;
  format: Format;
  /** Agent name. Used to resolve a per-agent `textPrefix` from
   *  config.tts.agentVoices. When omitted (e.g. /tts/synthesize
   *  called without context), falls back to config.tts.textPrefix. */
  agent?: string;
}

export interface SynthesizeOutput {
  bytes: Buffer;
  mime: string;
  cacheKey: string;
  cacheHit: boolean;
  ext: string;
  durationMs?: number;
}

/**
 * Generate (or fetch from cache) the spoken audio for `input.text`.
 *
 * On cache miss: POSTs to the configured TTS upstream's
 * `/v1/audio/speech`. Upstream returns raw audio bytes (WAV by default
 * for mlx-audio backends). If the requested `format` differs from WAV,
 * ffmpeg re-encodes before caching.
 *
 * The returned bytes match the requested `format` and are also written
 * to disk at cachePath(cacheKey, format), atomically via tmp+rename.
 */
export async function synthesize(input: SynthesizeInput, config: Config): Promise<SynthesizeOutput> {
  const tts = config.tts as TtsConfig;
  if (!tts || !tts.enabled) {
    throw new Error('tts not enabled in config.yaml');
  }
  const provider = config.providers[tts.provider];
  if (!provider) {
    throw new Error(`tts.provider '${tts.provider}' not found in providers`);
  }
  if (provider.engine !== 'openai-compatible') {
    throw new Error(`tts.provider '${tts.provider}' is engine '${provider.engine}', needs openai-compatible`);
  }

  ensureCacheDir();
  const voice = input.voice ?? tts.voice;
  // Resolve text-prefix: per-agent override wins, then global default,
  // then nothing. Prefix is prepended to the input BEFORE both the
  // cache-key compute and the upstream call, so different speakers
  // get different cached files for the same reply text.
  const perAgentPrefix = input.agent ? tts.agentVoices?.[input.agent] : undefined;
  const prefix = perAgentPrefix ?? tts.textPrefix ?? '';
  const finalInput = prefix + input.text;
  const cacheKey = computeCacheKey(finalInput, voice, tts.model, input.format);
  const outPath = cachePath(cacheKey, input.format);
  const spec = FORMATS[input.format];

  // ── cache hit ──
  if (existsSync(outPath)) {
    try {
      const bytes = await readFile(outPath);
      logger.info({ msg: 'tts.cache_hit', cacheKey, format: input.format, bytes: bytes.length });
      return { bytes, mime: spec.mime, cacheKey, cacheHit: true, ext: spec.ext };
    } catch (err) {
      logger.warn({ msg: 'tts.cache_read_failed', cacheKey, err: (err as Error).message });
      // fall through to regenerate
    }
  }

  // ── cache miss → upstream ──
  // STT path-convention: baseUrl already ends in /v1 (e.g.
  // http://host:11434/v1), so we only append `/audio/speech`, mirroring
  // src/server/index.ts:/stt/transcribe which does the same with
  // `/audio/transcriptions`.
  const url = provider.baseUrl.replace(/\/+$/, '') + '/audio/speech';
  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    model: tts.model,
    input: finalInput,
  };
  if (voice) body.voice = voice;
  const language = input.language ?? tts.language;
  if (language) body.language = language;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ msg: 'tts.upstream_unreachable', url, err: msg });
    throw new Error(`TTS upstream unreachable: ${msg}`);
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    logger.warn({ msg: 'tts.upstream_error', status: upstream.status, body: text.slice(0, 500) });
    throw new Error(`TTS upstream returned ${upstream.status}: ${text.slice(0, 200)}`);
  }
  const wavBytes = Buffer.from(await upstream.arrayBuffer());
  const upstreamMs = Date.now() - startedAt;
  logger.info({
    msg: 'tts.upstream_ok',
    provider: tts.provider,
    model: tts.model,
    chars: input.text.length,
    wavBytes: wavBytes.length,
    ms: upstreamMs,
  });

  // ── re-encode if needed ──
  let finalBytes: Buffer = wavBytes;
  if (input.format !== 'wav') {
    if (!tts.reencode.enabled) {
      // Caller asked for opus/mp4 but reencode is off — fall back to wav.
      // Negotiator should have prevented this, but defense in depth.
      finalBytes = wavBytes;
    } else {
      const reencStart = Date.now();
      try {
        finalBytes = await ffmpegReencode(wavBytes, input.format, tts.reencode.opusBitrateKbps);
        logger.info({
          msg: 'tts.reencoded',
          format: input.format,
          inBytes: wavBytes.length,
          outBytes: finalBytes.length,
          ms: Date.now() - reencStart,
        });
      } catch (err) {
        logger.warn({ msg: 'tts.reencode_failed', err: (err as Error).message, format: input.format });
        throw new Error(`TTS re-encode failed: ${(err as Error).message}`);
      }
    }
  }

  // ── write cache atomically ──
  const tmpPath = outPath + '.tmp';
  await writeFile(tmpPath, finalBytes);
  try {
    await rename(tmpPath, outPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  // ── derive durationMs (rough; for opus/mp4 we don't know easily,
  //    return undefined and let clients compute on-play) ──
  let durationMs: number | undefined;
  if (input.format === 'wav') {
    durationMs = estimateWavDurationMs(wavBytes);
  }

  return {
    bytes: finalBytes,
    mime: spec.mime,
    cacheKey,
    cacheHit: false,
    ext: spec.ext,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * Best-effort WAV duration estimate from the header. Returns
 * undefined on any parse problem — durationMs is metadata, not
 * load-bearing for playback.
 */
function estimateWavDurationMs(wav: Buffer): number | undefined {
  if (wav.length < 44) return undefined;
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return undefined;
  if (wav.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  // fmt chunk: byteRate at offset 28 (little-endian 4 bytes)
  const byteRate = wav.readUInt32LE(28);
  if (byteRate === 0) return undefined;
  // data chunk size — scan for 'data' tag (usually at 36 but not guaranteed)
  for (let i = 12; i < Math.min(wav.length - 8, 200); i += 1) {
    if (wav.toString('ascii', i, i + 4) === 'data') {
      const dataSize = wav.readUInt32LE(i + 4);
      return Math.round((dataSize / byteRate) * 1000);
    }
  }
  return undefined;
}

/** Stat helper for the HTTP route — does the cache file exist? */
export function cacheFileStat(cacheKey: string, fmt: Format): { path: string; size: number } | null {
  const p = cachePath(cacheKey, fmt);
  if (!existsSync(p)) return null;
  try {
    const s = statSync(p);
    return { path: p, size: s.size };
  } catch {
    return null;
  }
}
