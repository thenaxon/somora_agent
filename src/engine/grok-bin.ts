// Which Grok CLI binary a turn runs.
//
// somora ships the Grok CLI like it ships Codex: the platform packages of
// xAI's official npm package (`@xai-official/grok-<platform>-<arch>`, one
// compressed binary each) are optional dependencies, pinned to the version
// somora is tested with. The main `@xai-official/grok` package is NOT a
// dependency: its postinstall writes into the user's ~/.grok (a binary in
// ~/.grok/bin and `installer = "npm"` in their config.toml) — somora must
// not touch a person's own Grok setup.
//
// The binary ships brotli-compressed; somora unpacks it once into its own
// Grok home as `bin/grok-<version>`, so a somora update that pins a newer
// Grok takes effect on the next turn, and the person's ~/.grok stays out.
//
// Order: SOMORA_GROK_BIN → the bundled binary → ~/.local/bin/grok →
// `grok` on PATH (an unsupported platform, or a broken install).

import { createReadStream, createWriteStream, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress } from 'node:zlib';
import { logger } from '../server/logger.ts';
import { somoraGrokHome } from './grok-home.ts';

export interface GrokLaunch {
  bin: string;
  source: 'override' | 'bundled' | 'local' | 'path';
  version: string | null;
}

/** The bundled platform package for this machine, if npm installed one. */
export function bundledGrokPackage(): { dir: string; version: string } | null {
  const req = createRequire(import.meta.url);
  try {
    const pkgPath = req.resolve(`@xai-official/grok-${process.platform}-${process.arch}/package.json`);
    const version = (req(pkgPath) as { version?: string }).version;
    return version ? { dir: dirname(pkgPath), version } : null;
  } catch {
    return null;
  }
}

let unpacking: Promise<string | null> | null = null;

/** Unpack the bundled binary into somora's Grok home once per version;
 *  older unpacked versions are removed. Null when nothing is bundled. */
export async function ensureBundledGrok(): Promise<string | null> {
  const pkg = bundledGrokPackage();
  if (!pkg) return null;
  const binDir = join(somoraGrokHome(), 'bin');
  const target = join(binDir, `grok-${pkg.version}`);
  if (existsSync(target)) return target;
  // Two turns starting at once share one unpack.
  unpacking ??= (async () => {
    try {
      await mkdir(binDir, { recursive: true, mode: 0o700 });
      const tmp = `${target}.tmp.${process.pid}`;
      const compressed = join(pkg.dir, 'bin', 'grok.br');
      const plain = join(pkg.dir, 'bin', 'grok');
      const t0 = Date.now();
      if (existsSync(compressed)) {
        await pipeline(createReadStream(compressed), createBrotliDecompress(), createWriteStream(tmp));
      } else if (existsSync(plain)) {
        await copyFile(plain, tmp);
      } else {
        logger.warn({ msg: 'engine.grok_bundled_missing', dir: pkg.dir });
        return null;
      }
      await chmod(tmp, 0o755);
      await rename(tmp, target);
      for (const f of readdirSync(binDir)) {
        if (f.startsWith('grok-') && f !== `grok-${pkg.version}`) {
          try {
            unlinkSync(join(binDir, f));
          } catch {
            /* in use or gone */
          }
        }
      }
      logger.info({ msg: 'engine.grok_bundled_unpacked', version: pkg.version, ms: Date.now() - t0 });
      return target;
    } catch (err) {
      logger.warn({ msg: 'engine.grok_bundled_unpack_failed', err: String(err) });
      await unlink(`${target}.tmp.${process.pid}`).catch(() => undefined);
      return null;
    } finally {
      unpacking = null;
    }
  })();
  return unpacking;
}

/** Resolved on every turn: an override, a newly installed CLI or a new
 *  bundled version is picked up without a restart. */
export async function resolveGrokLaunch(): Promise<GrokLaunch> {
  if (process.env.SOMORA_GROK_BIN) return { bin: process.env.SOMORA_GROK_BIN, source: 'override', version: null };
  const bundled = await ensureBundledGrok();
  if (bundled) return { bin: bundled, source: 'bundled', version: bundledGrokPackage()?.version ?? null };
  const localBin = join(homedir(), '.local', 'bin', 'grok');
  if (existsSync(localBin)) return { bin: localBin, source: 'local', version: null };
  return { bin: 'grok', source: 'path', version: null };
}
