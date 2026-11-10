// A wiki page path from a dream model's answer turned into a file path.
// Deep and Lucid take `wikiPath`, `slug`, `target`, `keep`, `drop` from
// the model's JSON; a note with planted text could make it answer
// `../../x` and overwrite any .md file the server can write, unattended
// (Fable review 2026-11-10 Nr. 8). The wiki_* tools had a check; the
// dream actions joined the path as given. Every such path goes through
// here: relative, no `..` segment, no backslash or NUL, and the result
// inside the wiki folder.

import { isAbsolute, join, relative, resolve } from 'node:path';

export class WikiPathError extends Error {}

/** `<wikiAbs>/<rel>.md`, or a WikiPathError for a path that leaves the wiki. */
export function wikiFile(wikiAbs: string, rel: string): string {
  const p = String(rel ?? '').trim();
  if (!p || isAbsolute(p) || p.includes('\\') || p.includes('\0') || p.split('/').some((seg) => seg === '..')) {
    throw new WikiPathError(`invalid wiki path '${p.slice(0, 120)}'`);
  }
  const file = join(wikiAbs, `${p}.md`);
  const back = relative(resolve(wikiAbs), resolve(file));
  if (back.startsWith('..') || isAbsolute(back)) throw new WikiPathError(`wiki path '${p.slice(0, 120)}' leaves the wiki`);
  return file;
}
