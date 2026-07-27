// Version constraints + duplicate-install detection for skill binaries
// (2026-07-27, gog friction report §3.4).
//
// `requires.bins` entries may carry an optional version constraint:
//
//   requires:
//     bins: ["gog>=0.30", "jq"]
//
// Why: on the Lucy host TWO gog installs coexisted (v0.12 via linuxbrew,
// v0.34 via release tarball) with incompatible keyring layouts. somora's
// existence-only check said "gog present ✓" and the wrong one got used —
// an hour of misdiagnosis. With a constraint the skill goes unavailable
// with a precise reason; independently, finding the same bin at multiple
// paths raises a warning naming every copy.
//
// Cost control (checkAvailability runs on EVERY turn via
// loadAvailableSkills): `<bin> --version` is spawned once per
// (path, mtime) and cached for the server lifetime — after warmup a
// turn pays one stat per constrained bin. The duplicate scan stats the
// PATH ∪ known-brew dirs and is TTL-cached. Skills without constraints
// keep the old zero-spawn existence check.

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface BinRequirement {
  /** Bare binary name — what PATH lookup and env-scope matching use. */
  bin: string;
  /** Optional constraint, e.g. { op: '>=', version: '0.30' }. */
  constraint?: { op: '>=' | '<=' | '==' | '>' | '<'; version: string };
}

const REQ_RE = /^([A-Za-z0-9._+-]+?)\s*(>=|<=|==|>|<)\s*([0-9][0-9A-Za-z.-]*)$/;

/** Parse a `requires.bins` entry. Bare names pass through unchanged;
 *  unparseable constraint suffixes are treated as part of the name so
 *  the existence check fails loudly rather than silently dropping the
 *  constraint. */
export function parseBinRequirement(entry: string): BinRequirement {
  const m = REQ_RE.exec(entry.trim());
  if (!m) return { bin: entry.trim() };
  return {
    bin: m[1]!,
    constraint: { op: m[2] as '>=' | '<=' | '==' | '>' | '<', version: m[3]! },
  };
}

/** Numeric segment-wise version compare ("0.34.1" vs "0.30" → 1).
 *  Non-numeric segment parts compare as 0 (so "1.2-rc1" ≈ "1.2"). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function satisfiesConstraint(
  version: string,
  constraint: NonNullable<BinRequirement['constraint']>,
): boolean {
  const cmp = compareVersions(version, constraint.version);
  switch (constraint.op) {
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '==':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
  }
}

/** The same known user-install dirs the exec PATH enrichment uses —
 *  duplicated deliberately small instead of exporting from path-helpers
 *  to avoid a cycle; keep in sync with knownBinDirs() there. */
function scanDirs(): string[] {
  const home = process.env.HOME ?? '';
  return [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    '/home/linuxbrew/.linuxbrew/bin',
    '/home/linuxbrew/.linuxbrew/sbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/Homebrew/bin',
    join(home, '.local', 'bin'),
    join(home, 'go', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, 'bin'),
  ];
}

interface BinPathScan {
  /** All distinct real paths where the bin exists, in scan order —
   *  first entry is what a spawned command will actually run. */
  paths: string[];
  at: number;
}

const SCAN_TTL_MS = 60_000;
const scanCache = new Map<string, BinPathScan>();

/** Find every copy of a binary across PATH + known user-install dirs,
 *  deduplicated by realpath (a symlink and its target count once). */
export async function findAllBinPaths(bin: string): Promise<string[]> {
  const cached = scanCache.get(bin);
  if (cached && Date.now() - cached.at < SCAN_TTL_MS) return cached.paths;
  const seenReal = new Set<string>();
  const seenDir = new Set<string>();
  const paths: string[] = [];
  for (const dir of scanDirs()) {
    if (seenDir.has(dir)) continue;
    seenDir.add(dir);
    const candidate = join(dir, bin);
    try {
      const s = await stat(candidate);
      if (!s.isFile()) continue;
      const real = await realpath(candidate).catch(() => candidate);
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      paths.push(candidate);
    } catch {
      /* not here */
    }
  }
  scanCache.set(bin, { paths, at: Date.now() });
  return paths;
}

const VERSION_TIMEOUT_MS = 5_000;
const versionCache = new Map<string, string | null>(); // `${path}:${mtimeMs}` → version

/** Best-effort `<bin> --version` → first semver-ish token, cached by
 *  (path, mtime) so each binary is spawned at most once until it
 *  changes on disk. Returns null when the output has no version. */
export async function getBinVersion(binPath: string): Promise<string | null> {
  let mtime = 0;
  try {
    mtime = statSync(binPath).mtimeMs;
  } catch {
    return null;
  }
  const key = `${binPath}:${mtime}`;
  if (versionCache.has(key)) return versionCache.get(key)!;
  let version: string | null = null;
  try {
    const { stdout, stderr } = await execFileP(binPath, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
    });
    const m = /(\d+\.\d+(?:\.\d+)*)/.exec(`${stdout}\n${stderr}`);
    version = m ? m[1]! : null;
  } catch {
    version = null;
  }
  versionCache.set(key, version);
  return version;
}

export interface BinCheckResult {
  bin: string;
  ok: boolean;
  /** Availability-blocking reason (missing, or constraint violated). */
  reason?: string;
  /** Non-blocking findings (duplicate installs, unparseable version). */
  warnings: string[];
}

/** Full check for one `requires.bins` entry: existence, optional
 *  version constraint (against the FIRST copy in scan order — the one
 *  a spawned command runs), duplicate-install warning. */
export async function checkBinRequirement(entry: string): Promise<BinCheckResult> {
  const req = parseBinRequirement(entry);
  const paths = await findAllBinPaths(req.bin);
  if (paths.length === 0) {
    return { bin: req.bin, ok: false, reason: `missing bin: ${req.bin}`, warnings: [] };
  }
  const warnings: string[] = [];
  if (paths.length > 1) {
    const described = await Promise.all(
      paths.map(async (p) => {
        const v = await getBinVersion(p);
        return v ? `${p} (v${v})` : p;
      }),
    );
    warnings.push(
      `multiple installs of '${req.bin}' found — the first one wins for exec: ${described.join(', ')}. ` +
        `Remove or upgrade the stale copies to avoid version/keyring split-brain.`,
    );
  }
  if (req.constraint) {
    const activePath = paths[0]!;
    const version = await getBinVersion(activePath);
    if (version === null) {
      warnings.push(
        `could not determine '${req.bin}' version (\`--version\` unparseable at ${activePath}) — constraint '${req.constraint.op}${req.constraint.version}' not enforced`,
      );
    } else if (!satisfiesConstraint(version, req.constraint)) {
      return {
        bin: req.bin,
        ok: false,
        reason: `bin '${req.bin}' v${version} at ${activePath} does not satisfy '${req.constraint.op}${req.constraint.version}'`,
        warnings,
      };
    }
  }
  return { bin: req.bin, ok: true, warnings };
}

/** Test hook — drop caches. */
export function resetBinCheckCaches(): void {
  scanCache.clear();
  versionCache.clear();
}
