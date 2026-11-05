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

import { Scalar, isMap, isScalar, isSeq, parseDocument, stringify, type Document, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import { parseYaml } from '../yaml.ts';

/** `lists`, when given, says per path segment whether it is an index
 *  into a list (from the schema); without it, a segment of digits is.
 *  It matters where the file does not have the path yet: `mcp.servers.123`
 *  is a server named 123, `projects.entities.0` a first list entry. */
export type YamlEdit = ({ path: string[]; value: unknown } | { path: string[]; remove: true }) & { lists?: boolean[] };

const isIndex = (e: YamlEdit, i: number): boolean => (e.lists ? !!e.lists[i] : /^\d+$/.test(e.path[i] ?? ''));

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

/** A path segment as an index into a list, or an error. */
function seqIndex(seg: string, seq: YAMLSeq, path: string[], allowEnd: boolean): number {
  const i = /^\d+$/.test(seg) ? Number(seg) : -1;
  if (i < 0 || i > seq.items.length || (!allowEnd && i === seq.items.length)) {
    throw new YamlEditError(`${path.join('.')}: no entry ${seg} in that list`);
  }
  return i;
}

/** Apply one edit to the text; returns the new text. */
function applyOne(text: string, edit: YamlEdit): string {
  const doc = load(text);
  const root = doc.contents;
  if (!isMap(root)) throw new YamlEditError('config.yaml is not a map of settings');
  // Walk down as far as the file has the path. A list is walked by
  // index (`imageGen.models.1.label`); its entries are blocks again.
  let node: YAMLMap | YAMLSeq = root as YAMLMap;
  // The pair that holds the current block, when it is a block under a
  // key (not an entry of a list).
  let holder: Pair<Node, Node | null> | undefined;
  // The outermost one-line `{…}` block on the way, under a block key.
  let flowRoot: { pair: Pair<Node, Node | null>; depth: number } | undefined;
  let depth = 0;
  for (; depth < edit.path.length - 1; depth++) {
    const seg = edit.path[depth]!;
    if (isSeq(node)) {
      const item = node.items[seqIndex(seg, node, edit.path.slice(0, depth + 1), false)];
      if (!isMap(item)) throw new YamlEditError(`${edit.path.slice(0, depth + 1).join('.')} is not a block of settings; change it by hand`);
      node = item as YAMLMap;
      holder = undefined;
      continue;
    }
    const pair = findPair(node, seg);
    if (!pair) break;
    if (isSeq(pair.value) && !pair.value.flow) {
      node = pair.value as YAMLSeq;
      holder = pair;
      continue;
    }
    // A one-line list of entries (`models: [{…}, {…}]`): the list is
    // written anew on its line, every other entry kept.
    if (isSeq(pair.value) && pair.value.flow && pair.value.items.length > 0) return rewriteFlow(text, pair, depth, edit);
    if (!isMap(pair.value)) {
      if ('remove' in edit) return text; // nothing to remove below a non-block
      const rest = edit.path.slice(depth + 1);
      // `entities: []` or `entities:` with nothing: the first entry.
      const emptyList = (isSeq(pair.value) && pair.value.items.length === 0) || pair.value === null || (isScalar(pair.value) && pair.value.value === null);
      if (emptyList && rest.length === 1 && rest[0] === '0' && isIndex(edit, depth + 1)) return replacePair(text, pair, [edit.value]);
      // `memory:` with nothing, or a flow `{}`: write the whole block anew.
      if (rest.some((_, j) => isIndex(edit, depth + 1 + j))) throw new YamlEditError(`${edit.path.join('.')}: its list is not in the file yet; add the entry as a whole`);
      return replacePair(text, pair, nestValue({}, rest, edit.value));
    }
    holder = pair;
    node = pair.value as YAMLMap;
    if (!flowRoot && (node as YAMLMap & { flow?: boolean }).flow) flowRoot = { pair, depth };
  }
  const key = edit.path[depth]!;
  const restPath = edit.path.slice(depth + 1);

  // An entry of a list: replaced, added at the end, or removed.
  if (isSeq(node)) {
    const i = seqIndex(key, node, edit.path, !('remove' in edit));
    const item = node.items[i] as Node | undefined;
    if ('remove' in edit) {
      // The last entry: the list stays, empty, so the key keeps meaning "none".
      if (node.items.length === 1 && holder) return replacePair(text, holder, []);
      return removeSeqItem(text, item!);
    }
    if (item && isScalar(item) && item.range) {
      const inline = inlineScalar(edit.value, item.type);
      if (inline !== null) return text.slice(0, item.range[0]) + inline + text.slice(item.range[1]);
    }
    return item ? replaceSeqItem(text, item, edit.value) : appendSeqItem(text, node, edit.value);
  }
  const map = node;
  const pair = depth === edit.path.length - 1 ? findPair(map, key) : undefined;

  // A flow map (`server: {port: 1, allowedHosts: [a]}`) holds several
  // settings on one line: removing or adding one by its line would take
  // its neighbours along. Its entry is written anew as a block, with
  // every sibling kept. A plain value in it is still replaced in place.
  if (flowRoot) {
    const inPlace = !('remove' in edit) && pair?.value && isScalar(pair.value) && pair.value.range && inlineScalar(edit.value, pair.value.type) !== null;
    if (!inPlace) return rewriteFlow(text, flowRoot.pair, flowRoot.depth, edit);
  } else if ((map as YAMLMap & { flow?: boolean }).flow && !('remove' in edit) && !(pair?.value && isScalar(pair.value))) {
    throw new YamlEditError(`${edit.path.join('.')} sits in a one-line {…} block; change it by hand`);
  }

  if ('remove' in edit) {
    if (depth < edit.path.length - 1 || !pair) return text; // already absent
    return cascadeEmpty(removePair(text, pair), edit.path);
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
  // Not there: add under the deepest block the file has. A list that is
  // not there yet starts with its first entry.
  const lastAt = edit.path.length - 1;
  const firstOfNewList = restPath.length > 0 && restPath[restPath.length - 1] === '0' && isIndex(edit, lastAt) && !restPath.slice(0, -1).some((_, j) => isIndex(edit, depth + 1 + j));
  if (firstOfNewList) {
    const inner = restPath.slice(0, -1);
    return insertPair(text, map, key, inner.length === 0 ? [edit.value] : nestValue({}, inner, [edit.value]));
  }
  if (restPath.some((_, j) => isIndex(edit, depth + 1 + j))) throw new YamlEditError(`${edit.path.join('.')}: its list is not in the file yet; add the entry as a whole`);
  const value = restPath.length > 0 ? nestValue({}, restPath, edit.value) : edit.value;
  return insertPair(text, map, key, value);
}

/** Text span of a list entry: from the line of its `-` to the end of
 *  its last line. */
function seqItemSpan(text: string, item: Node): [number, number] {
  const r = item.range!;
  const start = lineStart(text, r[0]);
  let end = lineEnd(text, Math.max(r[1] - 1, r[0]));
  if (end < r[1]) end = lineEnd(text, r[1]);
  return [start, end];
}

/** The column of an entry's `-`. */
function dashColumn(text: string, item: Node): number {
  const start = lineStart(text, item.range![0]);
  const line = text.slice(start, item.range![0]);
  const dash = line.lastIndexOf('-');
  if (dash < 0) throw new YamlEditError('a list entry not on its own line; change it by hand');
  return dash;
}

/** `- …` lines for one entry, the dash at `indent`. */
function renderSeqItem(value: unknown, indent: number): string {
  const body = stringify([value], { indent: 2, lineWidth: 0 }).replace(/\n$/, '');
  const pad = ' '.repeat(indent);
  return `${body.split('\n').map((l) => pad + l).join('\n')}\n`;
}

function replaceSeqItem(text: string, item: Node, value: unknown): string {
  const indent = dashColumn(text, item);
  const [start, end] = seqItemSpan(text, item);
  return text.slice(0, start) + renderSeqItem(value, indent) + text.slice(end);
}

function appendSeqItem(text: string, seq: YAMLSeq, value: unknown): string {
  const last = seq.items[seq.items.length - 1] as Node | undefined;
  if (!last) throw new YamlEditError('cannot add to an empty list; change it by hand');
  const indent = dashColumn(text, last);
  const [, end] = seqItemSpan(text, last);
  const sep = end > 0 && text[end - 1] !== '\n' ? '\n' : '';
  return text.slice(0, end) + sep + renderSeqItem(value, indent) + text.slice(end);
}

function removeSeqItem(text: string, item: Node): string {
  const indent = dashColumn(text, item);
  let [start, end] = seqItemSpan(text, item);
  // Own comment lines directly above, at the dash's indentation.
  for (;;) {
    if (start === 0) break;
    const prevStart = lineStart(text, start - 1);
    const line = text.slice(prevStart, start - 1);
    if (/^\s*#/.test(line) && line.search(/\S/) === indent) start = prevStart;
    else break;
  }
  return text.slice(0, start) + text.slice(end);
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
  const rendered = renderEntry(String((k as { value?: unknown }).value), value, indent);
  // The first setting of a list entry keeps the `-` in front of it.
  const lead = text.slice(start, k.range![0]);
  return text.slice(0, start) + (/-\s*$/.test(lead) ? lead + rendered.slice(indent) : rendered) + text.slice(end);
}

function removePair(text: string, pair: Pair<Node, Node | null>): string {
  const k = pair.key as Node;
  const indent = column(text, k.range![0]);
  let [start, end] = pairSpan(text, pair);
  // The first setting of a list entry stands behind its `-`: the dash
  // moves to the next setting of the entry, or the entry stays as {}.
  const lead = text.slice(start, k.range![0]);
  if (/-\s*$/.test(lead)) {
    const nextEnd = lineEnd(text, end);
    const next = text.slice(end, nextEnd);
    if (next.length > indent && /^\s*$/.test(next.slice(0, indent)) && /^[^\s#]/.test(next.slice(indent))) {
      return text.slice(0, start) + lead + next.slice(indent) + text.slice(nextEnd);
    }
    if (end >= text.length || !/^\s*[^\s#]/.test(next) || next.search(/\S/) < indent) {
      return `${text.slice(0, start)}${lead}{}\n${text.slice(end)}`;
    }
    throw new YamlEditError('a comment sits between the settings of that list entry; change it by hand');
  }
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

/** All edits; throws YamlEditError when the result would not read back
 *  with exactly these values. Indexes into lists mean the entries as the
 *  file has them now: entries of a list are removed last, from the end,
 *  so an edit or a removal never moves another one's entry. */
const UNSAFE_KEY = new Set(['__proto__', 'constructor', 'prototype']);

export function applyYamlEdits(text: string, edits: YamlEdit[]): string {
  for (const e of edits) {
    if (e.path.length === 0 || e.path.some((k) => UNSAFE_KEY.has(k) || k === '')) throw new YamlEditError(`${e.path.join('.') || '(empty path)'}: not a setting`);
  }
  load(text); // refuses a file that is not valid YAML, with its reason
  const before = parseYaml(text) as unknown;
  const isListRemoval = (e: YamlEdit) => 'remove' in e && Array.isArray(getPath(before, e.path.slice(0, -1)));
  const removed = new Map<string, number[]>();
  for (const e of edits.filter(isListRemoval)) {
    const k = e.path.slice(0, -1).join('.');
    removed.set(k, [...(removed.get(k) ?? []), Number(e.path[e.path.length - 1])]);
  }
  const ordered = [
    ...edits.filter((e) => !isListRemoval(e)),
    ...edits
      .filter(isListRemoval)
      .sort((x, y) => y.path.length - x.path.length || Number(y.path[y.path.length - 1]) - Number(x.path[x.path.length - 1])),
  ];
  let next = text;
  for (const e of ordered) next = applyOne(next, e);
  let back: unknown;
  try {
    back = parseYaml(next);
  } catch (err) {
    throw new YamlEditError(`the change would make config.yaml unreadable: ${(err as Error).message}`);
  }
  // The whole file must read back as the old one with exactly these
  // changes: a damaged neighbour (a lost `-`, a sibling taken along)
  // is caught here, not only a wrong value.
  if (!sameData(back, expectedAfter(before, ordered))) {
    const wrong = edits.find((e) => !('remove' in e) && !deepEqual(getPath(back, afterRemovals(e.path, removed) ?? []), e.value));
    throw new YamlEditError(`${(wrong ?? edits[0]!).path.join('.')} would not read back as written; change it by hand`);
  }
  return next;
}

/** Where an entry stands after the list removals before it; null when
 *  the entry itself was removed. */
function afterRemovals(path: string[], removed: Map<string, number[]>): string[] | null {
  const out = [...path];
  for (let k = 1; k < out.length; k++) {
    const gone = removed.get(path.slice(0, k).join('.'));
    if (!gone || !/^\d+$/.test(out[k]!)) continue;
    const i = Number(path[k]);
    if (gone.includes(i)) return null;
    out[k] = String(i - gone.filter((g) => g < i).length);
  }
  return out;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** The file's data as it must read after the edits (in the order they
 *  are applied): a value set (missing blocks created, a list for a first
 *  entry `.0`), a setting removed with the blocks it leaves empty, an
 *  entry of a list taken out, a last entry leaving `[]`. */
function expectedAfter(before: unknown, edits: YamlEdit[]): unknown {
  const root = (clone(before) ?? {}) as Record<string, unknown>;
  for (const e of edits) {
    const chain: unknown[] = [root];
    let cur: unknown = root;
    for (let i = 0; i < e.path.length - 1; i++) {
      const seg = e.path[i]!;
      const box = cur as Record<string, unknown>;
      let nextNode = Array.isArray(box) ? box[Number(seg)] : own(box, seg);
      if (nextNode === undefined || nextNode === null || typeof nextNode !== 'object') {
        if ('remove' in e) { cur = undefined; break; }
        nextNode = isIndex(e, i + 1) ? [] : {};
        if (Array.isArray(box)) box[Number(seg)] = nextNode;
        else box[seg] = nextNode;
      }
      cur = nextNode;
      chain.push(cur);
    }
    if (cur === undefined) continue;
    const last = e.path[e.path.length - 1]!;
    if ('remove' in e) {
      if (Array.isArray(cur)) cur.splice(Number(last), 1);
      else delete (cur as Record<string, unknown>)[last];
      // Emptied blocks go too, up the chain, but never a list or an entry of one.
      for (let i = chain.length - 1; i > 0; i--) {
        const node = chain[i];
        const parent = chain[i - 1];
        if (Array.isArray(node) || Array.isArray(parent) || Object.keys(node as object).length > 0) break;
        delete (parent as Record<string, unknown>)[e.path[i - 1]!];
      }
    } else if (Array.isArray(cur)) cur[Number(last)] = clone(e.value);
    else (cur as Record<string, unknown>)[last] = clone(e.value);
  }
  return root;
}

/** Equal data, whatever the order of keys. */
function sameData(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameData(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b || (a == null && b == null);
}

/** After a setting is removed, the blocks it leaves empty go too, up
 *  the chain — but never an entry of a list, and never the list. */
function cascadeEmpty(text: string, path: string[]): string {
  let next = text;
  for (let j = path.length - 2; j >= 0; j--) {
    const d = load(next);
    const node = d.getIn(path.slice(0, j + 1), true);
    const emptied = node === null || node === undefined || isEmptyMap(node) || (isScalar(node) && node.value === null);
    if (!emptied) break;
    const container = j === 0 ? d.contents : d.getIn(path.slice(0, j), true);
    if (!isMap(container)) break;
    const p = findPair(container as YAMLMap, path[j]!);
    if (!p) break;
    next = removePair(next, p);
  }
  return next;
}


/** Apply an edit to a one-line `{…}` or `[…]` value as data and write it
 *  back on its line (a comment behind it stays). Emptied, the key goes
 *  (a list stays as `[]`). */
function rewriteFlow(text: string, pair: Pair<Node, Node | null>, depth: number, edit: YamlEdit): string {
  const v = pair.value as YAMLMap | YAMLSeq;
  const data = v.toJSON() as unknown;
  const rel = edit.path.slice(depth + 1);
  if ('remove' in edit) {
    if (getPath(data, rel) === undefined) return text;
    removeIn(data, rel);
  } else setIn(data, rel, edit.value, (j) => isIndex(edit, depth + 1 + j));
  if (!Array.isArray(data) && Object.keys(data as object).length === 0) {
    return cascadeEmpty(removePair(text, pair), edit.path.slice(0, depth + 1));
  }
  const flow = stringify(data, { collectionStyle: 'flow', lineWidth: 0 }).replace(/\n$/, '');
  if (flow.includes('\n') || !v.range) return replacePair(text, pair, data);
  return text.slice(0, v.range[0]) + flow + text.slice(v.range[1]);
}

/** Own-property containers only: a key never reaches a prototype. */
function own(o: unknown, k: string): unknown {
  return o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;
}

function setIn(data: unknown, path: string[], value: unknown, index: (i: number) => boolean): void {
  let cur = data as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    let nextNode = own(cur, path[i]!);
    if (!nextNode || typeof nextNode !== 'object') {
      nextNode = index(i + 1) ? [] : {};
      cur[path[i]!] = nextNode;
    }
    cur = nextNode as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

/** Remove a path in plain data: a list entry is taken out, a key
 *  deleted, and blocks it leaves empty go too (never a list). */
function removeIn(data: unknown, path: string[]): void {
  const [head, ...rest] = path;
  if (Array.isArray(data)) {
    const i = Number(head);
    if (rest.length === 0) data.splice(i, 1);
    else removeIn(data[i], rest);
    return;
  }
  if (!data || typeof data !== 'object') return;
  const o = data as Record<string, unknown>;
  if (rest.length === 0) {
    delete o[head!];
    return;
  }
  const inner = own(o, head!);
  removeIn(inner, rest);
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && Object.keys(inner).length === 0) delete o[head!];
}
