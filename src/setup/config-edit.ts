// Comment-preserving edits of config.yaml and agent.yaml for the setup
// assistant. Every write goes through `commit`: backup first, then the
// new text is parsed and validated BEFORE it replaces the file — a
// config the server would refuse is never left on disk.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseYaml as parseYamlStrict } from '../config/yaml.ts';
import { Document, isMap, isNode, isScalar, isSeq, parseDocument, type Scalar, type YAMLMap } from 'yaml';

import { assertUniqueAliases, ConfigSchema } from '../config/types.ts';
import type { ModelPreset } from './presets.ts';

export const BASE_CONFIG = `# somora server config. Written by \`somora setup\`; edit by hand any time
# (gear menu → Reload config, or restart). Every option, with comments:
# config.example.yaml in the package and docs/setup.md.

server:
  host: 127.0.0.1
  port: 18737

providers: {}
`;

export interface YamlFile {
  path: string;
  doc: Document;
  /** Text on disk when loaded; '' for a file that does not exist yet. */
  original: string;
  /** The document as it renders untouched — re-rendering alone may
   *  normalise whitespace, which is not a change worth a backup. */
  baseline: string;
}

export function openYaml(path: string, fallbackText = ''): YamlFile {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const doc = parseDocument(original || fallbackText);
  if (doc.errors.length > 0) {
    throw new Error(`${path} is not valid YAML: ${doc.errors[0]!.message}`);
  }
  if (doc.contents === null) doc.contents = doc.createNode({}) as never;
  return { path, doc, original, baseline: original ? doc.toString({ lineWidth: 0, flowCollectionPadding: false }) : '' };
}

export function render(file: YamlFile): string {
  return file.doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** Set a nested value, creating maps on the way. An empty flow map
 *  (`providers: {}`) is turned into a block map so additions read well. */
export function setIn(file: YamlFile, path: string[], value: unknown): void {
  const newSection = !file.doc.has(path[0]!);
  for (let i = 1; i < path.length; i++) {
    const parent = file.doc.getIn(path.slice(0, i));
    if (isMap(parent) && parent.items.length === 0) parent.flow = false;
    // `key:` with nothing behind it parses as null — make it a map.
    if (parent === null || parent === undefined) file.doc.setIn(path.slice(0, i), file.doc.createNode({}));
  }
  // A plain object must become a node, or later reads inside it miss.
  const node = value !== null && typeof value === 'object' && !isNode(value) ? file.doc.createNode(value) : value;
  file.doc.setIn(path, node);
  // A new top-level section gets a blank line above it.
  if (newSection && isMap(file.doc.contents) && file.doc.contents.items.length > 1) {
    const pair = file.doc.contents.items.find((it) => (isScalar(it.key) ? it.key.value : it.key) === path[0]);
    if (pair) {
      if (!isScalar(pair.key)) pair.key = file.doc.createNode(path[0]) as never;
      (pair.key as Scalar).spaceBefore = true;
    }
  }
}

export function getIn(file: YamlFile, path: string[]): unknown {
  const node = file.doc.getIn(path);
  return node && typeof node === 'object' && 'toJSON' in node ? (node as { toJSON(): unknown }).toJSON() : node;
}

export function deleteIn(file: YamlFile, path: string[]): void {
  if (file.doc.hasIn(path)) file.doc.deleteIn(path);
}

function modelNode(doc: Document, m: ModelPreset): YAMLMap {
  const node = doc.createNode({
    id: m.id,
    alias: m.alias,
    contextWindow: m.contextWindow,
    capabilities: m.capabilities,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
  }) as YAMLMap;
  const caps = node.get('capabilities', true);
  if (isSeq(caps)) caps.flow = true;
  const levels = node.getIn(['reasoning', 'levels'], true);
  if (isMap(levels)) levels.flow = true;
  return node;
}

export interface ProviderInput {
  key: string;
  engine: string;
  baseUrl?: string;
  apiKey?: string;
  models: ModelPreset[];
}

/** Add a provider, or add the missing models to an existing one.
 *  Models already present (same id) are left exactly as they are.
 *  Returns the aliases that were added. */
export function upsertProvider(file: YamlFile, p: ProviderInput): string[] {
  const added: string[] = [];
  const existing = file.doc.getIn(['providers', p.key]);
  if (!isMap(existing)) {
    const node = file.doc.createNode({
      engine: p.engine,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      models: [],
    }) as YAMLMap;
    setIn(file, ['providers', p.key], node);
  } else {
    if (p.baseUrl) existing.set('baseUrl', p.baseUrl);
    if (p.apiKey) existing.set('apiKey', p.apiKey);
  }
  const provider = file.doc.getIn(['providers', p.key]) as YAMLMap;
  let models = provider.get('models', true);
  if (!isSeq(models)) {
    provider.set('models', file.doc.createNode([]));
    models = provider.get('models', true);
  }
  if (!isSeq(models)) throw new Error(`providers.${p.key}.models is not a list`);
  models.flow = false;
  const have = new Set((models.toJSON() as Array<{ id?: string }>).map((m) => m?.id));
  for (const m of p.models) {
    if (have.has(m.id)) continue;
    models.add(modelNode(file.doc, m));
    added.push(m.alias);
  }
  return added;
}

/** Every alias in the config, in file order. */
export function configuredAliases(file: YamlFile): Array<{ alias: string; provider: string; engine: string; id: string; capabilities: string[] }> {
  const providers = getIn(file, ['providers']) as Record<string, { engine?: string; models?: Array<{ id?: string; alias?: string; capabilities?: string[] }> }> | null;
  const out: Array<{ alias: string; provider: string; engine: string; id: string; capabilities: string[] }> = [];
  for (const [provider, p] of Object.entries(providers ?? {})) {
    for (const m of p?.models ?? []) {
      if (m?.alias && m.id) out.push({ alias: m.alias, provider, engine: p.engine ?? '', id: m.id, capabilities: m.capabilities ?? [] });
    }
  }
  return out;
}

function validateConfigText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseYamlStrict(text);
  } catch (err) {
    return `not valid YAML: ${(err as Error).message}`;
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    return result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  try {
    assertUniqueAliases(result.data);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

export interface CommitResult {
  changed: boolean;
  backup: string | null;
}

/** Write the document. `kind: 'config'` validates against the server's
 *  schema first and throws (leaving the file untouched) when the result
 *  would not load. The previous file is kept beside it as
 *  `<name>.bak-setup-<stamp>`. */
export function commit(file: YamlFile, kind: 'config' | 'plain', now: Date = new Date(), keepBackup = true): CommitResult {
  const text = render(file);
  if (text === file.original || text === file.baseline) return { changed: false, backup: null };
  if (kind === 'config') {
    const problem = validateConfigText(text);
    if (problem) throw new Error(`refusing to write ${file.path} — the result would not load: ${problem}`);
  } else {
    parseYamlStrict(text);
  }
  mkdirSync(dirname(file.path), { recursive: true });
  let backup: string | null = null;
  if (file.original && keepBackup) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    backup = `${file.path}.bak-setup-${stamp}`;
    copyFileSync(file.path, backup);
  }
  const tmp = `${file.path}.tmp-setup`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file.path);
  file.original = text;
  file.baseline = text;
  return { changed: true, backup };
}
