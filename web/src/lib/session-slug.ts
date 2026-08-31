// Client-side mirror of the server's session-slug rules
// (src/storage/sessions.ts: `[A-Za-z0-9_-]+`, `main` reserved), so the
// New-session field in the agent context menu can say what is wrong
// while the user types instead of after a 400 comes back.

const VALID_SLUG = /^[A-Za-z0-9_-]+$/;

export type SlugCheck = { ok: true; slug: string } | { ok: false; reason: string };

export function validateSessionSlug(raw: string): SlugCheck {
  const slug = raw.trim();
  if (slug.length === 0) return { ok: false, reason: 'Type a name for the session.' };
  if (slug === 'main') return { ok: false, reason: '"main" is the always-present default session.' };
  if (!VALID_SLUG.test(slug)) {
    return { ok: false, reason: 'Letters, digits, "-" and "_" only — no spaces.' };
  }
  return { ok: true, slug };
}

/** Turn free text into a likely-valid slug as the user types — spaces
 *  become dashes, everything else the server would reject is dropped.
 *  Suggestion only; validateSessionSlug still decides. */
export function suggestSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '');
}
