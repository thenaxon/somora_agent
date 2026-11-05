// Every setting of config.yaml as the settings window sees it
// (docs/web.md "Settings window"): its dotted path, what kind of value
// it takes, its limits and its default. Read from the Zod schema in
// src/config/types.ts through its JSON Schema, so a new setting appears
// here without anyone listing it. The explanation of each setting is
// the catalog's (settings/catalog.ts); a test holds the two together.

import { z } from 'zod';
import { ConfigSchema } from '../types.ts';

export type FieldKind =
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string'
  | 'enum'
  | 'strings' // a list of texts
  | 'one-or-many' // one text (a model alias) or a list of them
  | 'object' // a block of its own settings (optional when not required)
  | 'map' // named entries: `<name>: {...}`
  | 'list'; // a list of entries: `- {...}`

export interface SettingField {
  /** Dotted path; `*` stands for an entry name of a map or list. */
  path: string;
  kind: FieldKind;
  /** The top-level section the path belongs to. */
  section: string;
  default?: unknown;
  enum?: string[];
  min?: number;
  max?: number;
  /** A number that must be above `min`, not equal to it. */
  minExclusive?: boolean;
  nullable?: boolean;
  /** Required inside its parent block. */
  required?: boolean;
  /** A map of plain values: what each value is (a header is text). */
  valueKind?: 'string' | 'number' | 'integer' | 'boolean';
}

type Node = {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, Node>;
  required?: string[];
  additionalProperties?: Node | boolean;
  items?: Node;
  anyOf?: Node[];
  oneOf?: Node[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
};

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

let cache: SettingField[] | null = null;

function limits(n: Node): Pick<SettingField, 'min' | 'max' | 'minExclusive'> {
  const out: Pick<SettingField, 'min' | 'max' | 'minExclusive'> = {};
  if (typeof n.minimum === 'number') out.min = n.minimum;
  if (typeof n.exclusiveMinimum === 'number') {
    out.min = n.exclusiveMinimum;
    out.minExclusive = true;
  }
  if (typeof n.maximum === 'number' && n.maximum < SAFE_MAX) out.max = n.maximum;
  return out;
}

function walk(n: Node, path: string, section: string, required: boolean, out: SettingField[]): void {
  const base = { path, section, ...(n.default !== undefined ? { default: n.default } : {}), ...(required ? { required: true } : {}) };
  if (n.anyOf) {
    const nonNull = n.anyOf.filter((b) => b.type !== 'null');
    const nullable = nonNull.length < n.anyOf.length;
    if (nonNull.length === 1) {
      walk({ ...nonNull[0]!, ...(n.default !== undefined ? { default: n.default } : {}) }, path, section, required, out);
      if (nullable) out[out.length - 1] = { ...out[out.length - 1]!, nullable: true };
      return;
    }
    const types = nonNull.map((b) => b.type);
    // One of several blocks (`transport: {local: true}` or
    // `{resource: <name>}`): a block with every field of every variant;
    // the file is checked against the schema when it is applied.
    if (nonNull.every((b) => b.type === 'object' && b.properties)) {
      out.push({ ...base, kind: 'object', ...(nullable ? { nullable: true } : {}) });
      const seen = new Set<string>();
      for (const b of nonNull) {
        for (const [k, v] of Object.entries(b.properties ?? {})) {
          if (seen.has(k)) continue;
          seen.add(k);
          walk(v, `${path}.${k}`, section, false, out);
        }
      }
      return;
    }
    if (types.includes('string') && types.includes('array')) {
      out.push({ ...base, kind: 'one-or-many' });
      return;
    }
    out.push({ ...base, kind: 'string' });
    return;
  }
  if (n.enum) {
    out.push({ ...base, kind: 'enum', enum: n.enum.map(String) });
    return;
  }
  switch (n.type) {
    case 'boolean':
      out.push({ ...base, kind: 'boolean' });
      return;
    case 'integer':
    case 'number':
      out.push({ ...base, kind: n.type, ...limits(n) });
      return;
    case 'string':
      out.push({ ...base, kind: 'string' });
      return;
    case 'array': {
      const it = n.items ?? {};
      if (it.type === 'string' || it.enum) {
        out.push({ ...base, kind: 'strings', ...(it.enum ? { enum: it.enum.map(String) } : {}) });
        return;
      }
      out.push({ ...base, kind: 'list' });
      if (it.properties) for (const [k, v] of Object.entries(it.properties)) walk(v, `${path}.*.${k}`, section, (it.required ?? []).includes(k), out);
      return;
    }
    case 'object': {
      const ap = n.additionalProperties;
      if (!n.properties && ap && typeof ap === 'object') {
        const vt = typeof ap.type === 'string' && ['string', 'number', 'integer', 'boolean'].includes(ap.type) ? (ap.type as SettingField['valueKind']) : undefined;
        out.push({ ...base, kind: 'map', ...(vt ? { valueKind: vt } : {}) });
        if (ap.properties) for (const [k, v] of Object.entries(ap.properties)) walk(v, `${path}.*.${k}`, section, (ap.required ?? []).includes(k), out);
        else if (ap.anyOf || ap.oneOf) {
          // A map of variants (providers by engine): every field of every
          // variant, once.
          // A key that is a constant per variant (`engine`) is a choice
          // of those constants.
          const variants = ap.anyOf ?? ap.oneOf ?? [];
          const seen = new Set<string>();
          for (const b of variants) {
            for (const [k, v] of Object.entries(b.properties ?? {})) {
              if (seen.has(k)) continue;
              seen.add(k);
              const consts = variants.map((x) => (x.properties?.[k] as Node & { const?: unknown } | undefined)?.const).filter((c): c is string => typeof c === 'string');
              if (consts.length === variants.length) {
                out.push({ path: `${path}.*.${k}`, section, kind: 'enum', enum: consts, required: true });
                continue;
              }
              walk(v, `${path}.*.${k}`, section, false, out);
            }
          }
        }
        return;
      }
      if (path) out.push({ ...base, kind: 'object' });
      for (const [k, v] of Object.entries(n.properties ?? {})) walk(v, path ? `${path}.${k}` : k, section || k, (n.required ?? []).includes(k), out);
      return;
    }
    default:
      out.push({ ...base, kind: 'string' });
  }
}

/** All settings, in the order of the schema. */
export function settingFields(): SettingField[] {
  if (cache) return cache;
  const js = z.toJSONSchema(ConfigSchema, { unrepresentable: 'any', io: 'input' }) as Node;
  const out: SettingField[] = [];
  for (const [k, v] of Object.entries(js.properties ?? {})) walk(v, k, k, false, out);
  cache = out;
  return out;
}

/** The JSON Schema of the whole file (for clients that render it). */
export function settingsJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema, { unrepresentable: 'any', io: 'input' });
}

/** Does a concrete path (`providers.local.apiKey`) belong to a field
 *  path (`providers.*.apiKey`)? */
export function matchesFieldPath(fieldPath: string, concrete: string): boolean {
  const a = fieldPath.split('.');
  const b = concrete.split('.');
  return a.length === b.length && a.every((s, i) => s === '*' || s === b[i]);
}
