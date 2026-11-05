// Change single settings in config.yaml without rewriting the file
// (docs/web.md "Settings window"). The file is the operator's: their
// comments, blank lines, key order, quoting and indentation (also root
// keys indented by two spaces) stay as they are. Only the text of what
// changed is touched:
//
//   - a value that is there is replaced where it stands (a scalar in
//     place, so a comment behind it on the same line stays; a list or
//     block as the whole `key: …` entry);
//   - a setting that is not there is added under its parent, with the
//     parent's indentation, creating missing parent blocks;
//   - "back to the default" removes the entry, with the comment lines
//     directly above it, and a block left empty by that.
//
// The result is read back: every changed path must hold exactly the new
// value (or be gone), or nothing is returned. Same idea as the switch
// writer for agent.yaml (src/persona/yaml-switch.ts).

import { Scalar, isMap, isScalar, isSeq, parseDocument, stringify, type Document, type Node, type Pair, type YAMLMap } from 'yaml';
import { parseYaml } from '../yaml.ts';

export type YamlEdit = { path: string[]; value: unknown } | { path: string[]; remove: true };

export class YamlEditError extends Error {}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}
function lineEnd(text: string, offset: number): number {
  const i = text.indexOf('\n', offset);
  return i < 0 ? text.length : i + 1;
}
function column(text: string, offset: number): number {
  return offset - lineStart(text, offset);
}

function load(text: string): Document {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length > 0) throw new YamlEditError(`config.yaml is not valid YAML: ${doc.errors[0]!.message}`);
  return doc;
}

function findPair(map: YAMLMap, key: string): Pair<Node, Node | null> | undefined {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key) as Pair<Node, Node | null> | undefined;
}

/** `key: value` lines for a value under a key, indented by `indent`. */
function renderEntry(key: string, value: unknown, indent: number): string {
  const body = stringify({ [key]: value }, { indent: 2, lineWidth: 0 }).replace(/\n$/, '');
  const pad = ' '.repeat(indent);
  return `${body.split('\n').map((l) => pad + l).join('\n')}\n`;
}

type ScalarStyle = Scalar['type'];

/** A scalar written inline (in the quoting the old value had), or null
 *  when it needs more than one line or a block style. */
function inlineScalar(value: unknown, style?: ScalarStyle): string | null {
  if (value !== null && typeof value === 'object') return null;
  if (style === 'BLOCK_FOLDED' || style === 'BLOCK_LITERAL') return null;
  const quoted = typeof value === 'string' && (style === 'QUOTE_DOUBLE' || style === 'QUOTE_SINGLE');
  const s = stringify(value, { lineWidth: 0, ...(quoted ? { defaultStringType: style, defaultKeyType: 'PLAIN' } : {}) }).replace(/\n$/, '');
  return s.includes('\n') ? null : s;
}

/** The value as a node keeping the old value's style (a folded or
 *  literal block stays one). */
function styled(value: unknown, style?: ScalarStyle): unknown {
  if (typeof value !== 'string' || !style) return value;
  const n = new Scalar(value);
  n.type = style;
  return n;
}

function isEmptyMap(n: unknown): boolean {
  return isMap(n) && n.items.length === 0;
}

/** Apply one edit to the text; returns the new text. */
function applyOne(text: string, edit: YamlEdit): string {
  const doc = load(text);
  const root = doc.contents;
  if (!isMap(root)) throw new YamlEditError('config.yaml is not a map of settings');
  // Walk down as far as the file has the path.
  let map: YAMLMap = root as YAMLMap;
  const parents: Array<{ map: YAMLMap; pair: Pair<Node, Node | null> }> = [];
  let depth = 0;
  for (; depth < edit.path.length - 1; depth++) {
    const pair = findPair(map, edit.path[depth]!);
    if (!pair) break;
    if (!isMap(pair.value)) {
      if ('remove' in edit) return text; // nothing to remove below a non-block
      // `memory:` with nothing, or a flow `{}`: write the whole block anew.
      const rest = edit.path.slice(depth + 1);
      const current = pair.value && isMap(pair.value) ? (pair.value.toJSON() as Record<string, unknown>) : {};
      return replacePair(text, pair, nestValue(current, rest, edit.value));
    }
    parents.push({ map, pair });
    map = pair.value as YAMLMap;
  }
  const key = edit.path[depth]!;
  const restPath = edit.path.slice(depth + 1);
  const pair = depth === edit.path.length - 1 ? findPair(map, key) : undefined;

  // A flow map (`server: {port: 1, allowedHosts: [a]}`) holds several
  // settings on one line: removing or adding one by its line would take
  // its neighbours along. Its entry is written anew as a block, with
  // every sibling kept. A plain value in it is still replaced in place.
  if ((map as YAMLMap & { flow?: boolean }).flow) {
    const inPlace = !('remove' in edit) && pair?.value && isScalar(pair.value) && pair.value.range && inlineScalar(edit.value, pair.value.type) !== null;
    if (!inPlace) {
      const parent = parents[parents.length - 1];
      if (!parent) throw new YamlEditError('config.yaml is written as one flow map; change it by hand');
      const obj = { ...(map.toJSON() as Record<string, unknown>) };
      if ('remove' in edit) {
        if (!pair) return text;
        delete obj[key];
      } else obj[key] = restPath.length > 0 ? nestValue((obj[key] ?? {}) as Record<string, unknown>, restPath, edit.value) : edit.value;
      return Object.keys(obj).length === 0 ? removePair(text, parent.pair) : replacePair(text, parent.pair, obj);
    }
  }

  if ('remove' in edit) {
    if (depth < edit.path.length - 1 || !pair) return text; // already absent
    let next = removePair(text, pair);
    // A block left empty goes too, up the chain.
    for (let i = parents.length - 1; i >= 0; i--) {
      const d = load(next);
      const path = edit.path.slice(0, i + 1);
      const node = d.getIn(path, true);
      const emptied = node === null || node === undefined || isEmptyMap(node) || (isScalar(node) && node.value === null);
      if (!emptied) break;
      const parentNode = i === 0 ? d.contents : d.getIn(edit.path.slice(0, i), true);
      if (!isMap(parentNode)) break;
      const p = findPair(parentNode as YAMLMap, edit.path[i]!);
      if (!p) break;
      next = removePair(next, p);
    }
    return next;
  }

  if (pair) {
    const v = pair.value;
    const style = v && isScalar(v) ? v.type : undefined;
    // The same value: nothing to write (a quoted key stays quoted).
    if (v && isScalar(v) && deepEqual(v.value, edit.value)) return text;
    const inline = inlineScalar(edit.value, style);
    if (v && isScalar(v) && v.range && inline !== null) {
      return text.slice(0, v.range[0]) + inline + text.slice(v.range[1]);
    }
    if (v && isScalar(v) && (style === 'BLOCK_FOLDED' || style === 'BLOCK_LITERAL')) return replacePair(text, pair, styled(edit.value, style));
    if (v && isSeq(v) && v.flow && v.range && Array.isArray(edit.value) && edit.value.every((x) => inlineScalar(x) !== null)) {
      const flow = `[${(edit.value as unknown[]).map((x) => inlineScalar(x)).join(', ')}]`;
      return text.slice(0, v.range[0]) + flow + text.slice(v.range[1]);
    }
    return replacePair(text, pair, edit.value);
  }
  // Not there: add under the deepest block the file has.
  const value = restPath.length > 0 ? nestValue({}, restPath, edit.value) : edit.value;
  return insertPair(text, map, key, value);
}

function nestValue(base: Record<string, unknown>, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...tail] = path;
  const inner = (base[head!] && typeof base[head!] === 'object' ? (base[head!] as Record<string, unknown>) : {}) as Record<string, unknown>;
  return { ...base, [head!]: nestValue(inner, tail, value) };
}

/** Text span of a pair: from its line start to the end of its value. */
function pairSpan(text: string, pair: Pair<Node, Node | null>): [number, number] {
  const k = pair.key as Node;
  const start = lineStart(text, k.range![0]);
  const valueEnd = pair.value?.range ? pair.value.range[1] : k.range![2];
  // A comment on the value's own last line belongs to it.
  let end = lineEnd(text, Math.max(valueEnd - 1, k.range![0]));
  // A block value's range may stop before its last line's newline.
  if (end < valueEnd) end = lineEnd(text, valueEnd);
  return [start, end];
}

function replacePair(text: string, pair: Pair<Node, Node | null>, value: unknown): string {
  const k = pair.key as Node;
  const indent = column(text, k.range![0]);
  const [start, end] = pairSpan(text, pair);
  return text.slice(0, start) + renderEntry(String((k as { value?: unknown }).value), value, indent) + text.slice(end);
}

function removePair(text: string, pair: Pair<Node, Node | null>): string {
  const k = pair.key as Node;
  const indent = column(text, k.range![0]);
  let [start, end] = pairSpan(text, pair);
  // Own comment lines directly above, at the same indentation.
  for (;;) {
    if (start === 0) break;
    const prevStart = lineStart(text, start - 1);
    const line = text.slice(prevStart, start - 1);
    if (/^\s*#/.test(line) && column(text, prevStart + line.search(/\S/)) === indent) start = prevStart;
    else break;
  }
  return text.slice(0, start) + text.slice(end);
}

function insertPair(text: string, map: YAMLMap, key: string, value: unknown): string {
  const items = map.items as Array<Pair<Node, Node | null>>;
  if (items.length === 0) throw new YamlEditError(`cannot add ${key}: its block is empty`);
  const first = items[0]!.key as Node;
  const indent = column(text, first.range![0]);
  const last = items[items.length - 1]!;
  const [, end] = pairSpan(text, last);
  const sep = end > 0 && text[end - 1] !== '\n' ? '\n' : '';
  return text.slice(0, end) + sep + renderEntry(key, value, indent) + text.slice(end);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** All edits in order; throws YamlEditError when the result would not
 *  read back with exactly these values. */
export function applyYamlEdits(text: string, edits: YamlEdit[]): string {
  let next = text;
  for (const e of edits) next = applyOne(next, e);
  let back: unknown;
  try {
    back = parseYaml(next);
  } catch (err) {
    throw new YamlEditError(`the change would make config.yaml unreadable: ${(err as Error).message}`);
  }
  for (const e of edits) {
    const got = getPath(back, e.path);
    if ('remove' in e ? got !== undefined : !deepEqual(got, e.value)) {
      throw new YamlEditError(`${e.path.join('.')} would not read back as written; change it by hand`);
    }
  }
  return next;
}
