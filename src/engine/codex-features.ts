// Codex feature-flag probe for the `--disable <feature>` lock-down.
//
// `codex exec --disable <flag>` is a HARD error when the installed codex
// does not know the flag ("Error: Unknown feature flag: …"), while flags
// codex has since marked "removed" are still accepted. Our disable list
// tracks the newest audited codex (0.151: `view_image`, `skill_search`
// became feature flags), so on a host with an older codex every turn
// would die at spawn. The adapter therefore asks the installed binary
// once (`codex features list`, cached for the server lifetime) and only
// passes the flags that binary knows. If the probe fails, the full list
// goes through unchanged — the behaviour before this probe existed.

import { spawnSync } from 'node:child_process';
import { logger } from '../server/logger.ts';

/** Feature names from `codex features list` output: first column of
 *  every line that starts with an identifier. Header/blank lines are
 *  skipped by the identifier + whitespace shape. */
export function parseFeatureNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^([a-z][a-z0-9_]*)\s+\S/.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** Keep only flags the installed codex knows. `known === null` (probe
 *  failed) keeps everything. */
export function filterDisableFlags(
  wanted: ReadonlyArray<string>,
  known: ReadonlySet<string> | null,
): { flags: string[]; skipped: string[] } {
  if (!known) return { flags: [...wanted], skipped: [] };
  const flags: string[] = [];
  const skipped: string[] = [];
  for (const f of wanted) (known.has(f) ? flags : skipped).push(f);
  return { flags, skipped };
}

let cached: { bin: string; known: Set<string> | null } | undefined;

/** Probe once per process; a probe that yields fewer than 10 names is
 *  treated as failed (wrong binary, changed output format). */
export function knownCodexFeatures(bin: string): Set<string> | null {
  if (cached && cached.bin === bin) return cached.known;
  let known: Set<string> | null = null;
  try {
    const r = spawnSync(bin, ['features', 'list'], { encoding: 'utf8', timeout: 15_000 });
    if (r.status === 0) {
      const names = parseFeatureNames(r.stdout);
      if (names.size >= 10) known = names;
    }
    if (!known) {
      logger.warn({
        msg: 'engine.codex_features_probe_failed',
        bin,
        status: r.status,
        stderr: String(r.stderr ?? '').slice(0, 300),
        hint: 'passing the full --disable list; an unknown flag would abort every codex turn',
      });
    }
  } catch (err) {
    logger.warn({ msg: 'engine.codex_features_probe_failed', bin, err: String(err) });
  }
  cached = { bin, known };
  return known;
}

/** The `--disable` argv fragment for this host's codex. */
export function codexDisableArgs(bin: string, wanted: ReadonlyArray<string>): string[] {
  const { flags, skipped } = filterDisableFlags(wanted, knownCodexFeatures(bin));
  if (skipped.length > 0 && !skippedLogged) {
    skippedLogged = true;
    logger.info({
      msg: 'engine.codex_features_skipped',
      bin,
      skipped,
      hint: 'installed codex does not know these feature flags (older version) — not passed to --disable',
    });
  }
  return flags.flatMap((f) => ['--disable', f]);
}
let skippedLogged = false;
