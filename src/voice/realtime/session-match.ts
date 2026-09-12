// Finding the session somebody just said out loud.
//
// This exists ONLY for voice. Everywhere else a session name is typed,
// and a typed name that is wrong must stay wrong — a slash command or an
// API call that lands "approximately" somewhere is a bug, not a
// convenience. Here the name went through a microphone, a speech
// recogniser and a model that writes what it thinks it heard, and it
// comes out different every single time:
//
//   said "CerebroCraft"  →  Cerebokräft · craft · CerebroCraft
//   said "voicecheck"    →  voice-check
//
// All four reached the server on 2026-09-12 and all four missed
// `cerebrocraft` and `voicecheck`, which is why no call ever got into a
// session other than main. Matching is therefore done on sound-ish
// shape, not on spelling — and where the shape is ambiguous the voice
// asks instead of guessing, because landing in the wrong conversation is
// worse than one more question.

/** Letters and digits only, lower case, umlauts folded. What survives is
 *  roughly what two people would agree they heard. */
export function normalizeSpokenName(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Levenshtein distance, iterative, two rows. Names are short. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** 1 = identical, 0 = nothing in common. */
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - distance(a, b) / longest;
}

/**
 * How close a heard name has to be before we accept it.
 *
 * `Cerebokräft` against `cerebrocraft` scores 0.83 — a missing letter
 * and a k for a c, which is what German speech recognition does to an
 * English word. Below 0.7 the two words no longer sound like each other
 * and a match would be a guess.
 */
const MIN_SIMILARITY = 0.7;

/** A clear winner has to beat the runner-up by this much. Two sessions
 *  that sound equally close are a question, not a decision. */
const MIN_MARGIN = 0.08;

export type SessionMatch =
  | { kind: 'one'; slug: string }
  | { kind: 'many'; candidates: string[] }
  | { kind: 'none' };

/**
 * Pick the session a caller meant.
 *
 * Exact first, then containment (a model that heard "CerebroCraft" may
 * pass only "craft"), then similarity. `main` always exists and is
 * always a candidate.
 */
export function matchSpokenSession(spoken: string, slugs: readonly string[]): SessionMatch {
  const needle = normalizeSpokenName(spoken);
  if (needle.length === 0) return { kind: 'none' };
  const pool = [...new Set(['main', ...slugs])];

  const exact = pool.filter((s) => normalizeSpokenName(s) === needle);
  if (exact.length === 1) return { kind: 'one', slug: exact[0]! };
  if (exact.length > 1) return { kind: 'many', candidates: exact };

  // Containment, but only for a fragment long enough to mean something:
  // "ai" inside half the session names is not a wish.
  if (needle.length >= 4) {
    const contained = pool.filter((s) => {
      const n = normalizeSpokenName(s);
      return n.includes(needle) || needle.includes(n);
    });
    if (contained.length === 1) return { kind: 'one', slug: contained[0]! };
    if (contained.length > 1) return { kind: 'many', candidates: contained.slice(0, 4) };
  }

  const scored = pool
    .map((slug) => ({ slug, score: similarity(needle, normalizeSpokenName(slug)) }))
    .filter((s) => s.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { kind: 'none' };
  const best = scored[0]!;
  const runnerUp = scored[1];
  if (!runnerUp || best.score - runnerUp.score >= MIN_MARGIN) return { kind: 'one', slug: best.slug };
  return { kind: 'many', candidates: scored.slice(0, 4).map((s) => s.slug) };
}
