// Memory-note slug normaliser. The validator in MemoryManager / the
// memory_* tool schemas is strict (`^[a-z0-9][a-z0-9_-]*$`) on purpose —
// slugs become file names and wiki links. But the REM extractor is an
// LLM and writes what the conversation said: `iobroker-ablösung-2026-09-01`,
// `spiderman-liteLLM-multi-deployment-idee` (2026-09-03 report — four
// dream_apply calls failed on their own extractor's output). Normalise
// at the source (extraction) and once more at apply time for findings
// that were extracted before this existed.

const TRANSLITERATE: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  ø: 'oe',
  å: 'aa',
};

/**
 * `Ablösung LiteLLM` → `abloesung-litellm`. German umlauts transliterate
 * (ä→ae …), other accents drop their marks (NFKD), everything outside
 * `[a-z0-9_-]` becomes `-`, runs collapse, edges trim. Returns '' when
 * nothing survives (caller decides what to do with that).
 */
export function normalizeSlug(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/[äöüßæøå]/g, (ch) => TRANSLITERATE[ch] ?? ch);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9_-]+/g, '-');
  s = s.replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return s;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
