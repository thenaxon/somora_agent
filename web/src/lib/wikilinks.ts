// Obsidian `[[wikilink]]` → markdown link rewriting for the wiki reader.
//
// Kept out of the component so it can be tested without a DOM, and so
// the regex lives next to the note explaining why it looks like it does.

/** `[[target]]`, `[[target|alias]]`, `[[target#heading]]`.
 *
 *  Newlines are excluded from every group: Deep clips page descriptions
 *  in index.md without respecting link boundaries, and a
 *  newline-tolerant pattern turns the resulting `[[foo…` fragment into
 *  one "target" spanning the rest of the file. Mirrors the server-side
 *  pattern in src/wiki/explorer.ts — both must agree, or the reader
 *  linkifies something the index never resolved. */
export const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

/** Fenced blocks and inline code spans, in one alternation. */
const CODE_SPAN_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+)/g;

/**
 * Rewrite wikilinks into markdown links carrying a private scheme, so
 * the anchor handler can tell wiki navigation from ordinary links
 * without inspecting the text again.
 *
 * `targets` maps raw link text to a resolved slug (or null). It comes
 * from the server, which owns Obsidian's matching rules.
 *
 * Code spans are copied through untouched. The wiki documents its own
 * syntax — pages carry literal `` `[[personen/rene]]` `` as an example
 * — and rewriting those both breaks the example and leaves raw markdown
 * visible inside the code span. Ten such spans on the reference wiki as
 * of 2026-07-22.
 */
export function linkifyWikilinks(
  md: string,
  targets: Record<string, string | null>,
): string {
  const linkifyPlain = (text: string): string =>
    text.replace(WIKILINK_RE, (_m, rawTarget: string, alias?: string) => {
      const target = rawTarget.trim();
      const label = (alias ?? target).trim() || target;
      const slug = targets[target];
      // Brackets inside the label would re-open markdown link syntax.
      const safeLabel = label.replace(/[[\]]/g, '');
      return slug
        ? `[${safeLabel}](wiki:${encodeURIComponent(slug)})`
        : `[${safeLabel}](wiki-broken:${encodeURIComponent(target)})`;
    });

  const out: string[] = [];
  let last = 0;
  for (const m of md.matchAll(CODE_SPAN_RE)) {
    const at = m.index ?? 0;
    out.push(linkifyPlain(md.slice(last, at)));
    out.push(m[0]);
    last = at + m[0].length;
  }
  out.push(linkifyPlain(md.slice(last)));
  return out.join('');
}
