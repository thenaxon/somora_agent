// Import-time hygiene for tools discovered on external MCP servers
// (design: private/mcp-hub-design.md §4.2). Everything a server hands us
// is untrusted output — schemas go to LLM providers verbatim afterwards,
// so one malformed schema would 400 the whole API request for every
// conversation. We normalize known provider incompatibilities, cap
// descriptions, sanitize unicode, and fail closed on name collisions.
//
// The schema fix list is ported from hermes-agent's
// _normalize_mcp_input_schema (tools/mcp_tool.py:5357) — each entry is a
// real provider bug they hit in production:
//   1. `definitions` / `#/definitions/...` → `$defs` (Kimi/Moonshot
//      rejects the draft-07 form) — ONLY where `definitions` is a JSON
//      Schema meta-keyword, never when it's the name of a property
//      (Anthropic/OpenAI reject `$` in property names, so rewriting a
//      property called "definitions" would 400 the whole tool array).
//   2. Missing/null `type` on object-shaped nodes → "object".
//   3. `object` without `properties` → empty `properties` so `required`
//      doesn't dangle.
//   4. Prune `required` to names actually present in `properties`
//      (Gemini 400s on required-but-undefined properties).
//   5. `anyOf: [X, {type:"null"}], default: null` → collapse to X
//      (Anthropic rejects nullable unions in tool input schemas).

/** Max chars for a tool description (claude-code's cap — OpenAPI-
 *  generated servers dump 15-60KB into description). */
export const MAX_MCP_DESCRIPTION_CHARS = 2048;

/** API tool-name pattern ceiling — full name `mcp__<server>__<tool>`
 *  must fit `^[a-zA-Z0-9_-]{1,64}$`. */
export const MAX_TOOL_NAME_CHARS = 64;

const TOOL_NAME_SAFE = /[^A-Za-z0-9_-]/g;

/** Strip format/control/unassigned/private-use codepoints and normalize
 *  NFKC. Applied to every string in a discovered tool object (keys and
 *  values) — zero-widths and bidi controls are prompt-injection vectors
 *  in tool descriptions. */
export function sanitizeUnicodeString(s: string): string {
  // Cf covers zero-widths (200B-D), bidi controls (202A-E, 2066-69) and
  // BOM; Co = private use, Cn = unassigned.
  return s.normalize('NFKC').replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, '');
}

/** Recursively sanitize all string keys + values of a JSON-ish value. */
export function sanitizeUnicodeDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeUnicodeString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeUnicodeDeep(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeUnicodeString(k)] = sanitizeUnicodeDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

export function capDescription(desc: string | undefined): string {
  const d = desc ?? '';
  if (d.length <= MAX_MCP_DESCRIPTION_CHARS) return d;
  return `${d.slice(0, MAX_MCP_DESCRIPTION_CHARS)}… [truncated]`;
}

/** Redact obvious credential shapes from text destined for logs or LLM-
 *  visible error messages (Hermes pattern — upstream error bodies love
 *  to echo the Authorization header back). */
export function scrubCredentials(text: string): string {
  return text
    .replace(/\b(ghp|gho|ghu|ghs)_[A-Za-z0-9_]{8,255}/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,255}/g, '[redacted]')
    .replace(/\b(Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keys whose value is a map of property-name → schema. `definitions`
 *  under these is a PROPERTY NAME and must not be rewritten. */
const PROPERTY_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/**
 * Normalize a tools' inputSchema in place-ish (returns a deep-rewritten
 * copy). See the header comment for the fix list. Returns null when the
 * schema is structurally unusable (root not an object schema) — caller
 * skips that single tool instead of poisoning the API request.
 */
export function normalizeInputSchema(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) {
    // Servers occasionally send no schema at all — a zero-arg tool.
    if (raw === undefined || raw === null) return { type: 'object', properties: {} };
    return null;
  }
  const schema = rewriteNode(raw, /* inPropertyMap */ false) as Record<string, unknown>;
  // Root must be an object schema for every provider's tools array.
  if (schema.type !== 'object') {
    if (schema.type === undefined) schema.type = 'object';
    else return null;
  }
  if (!isPlainObject(schema.properties)) schema.properties = {};
  return schema;
}

function rewriteNode(node: unknown, inPropertyMap: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteNode(n, false));
  if (!isPlainObject(node)) {
    // Fix 1b: rewrite $ref targets pointing at draft-07 definitions.
    if (typeof node === 'string') return node;
    return node;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // Fix 1: `definitions` as meta-keyword → `$defs`. Inside a property
    // map the key is a user-facing property name — keep it verbatim.
    const isMetaDefinitions = key === 'definitions' && !inPropertyMap && isPlainObject(value);
    const outKey = isMetaDefinitions ? '$defs' : key;
    const childIsPropertyMap = PROPERTY_MAP_KEYS.has(key) && !inPropertyMap;
    if (key === '$ref' && typeof value === 'string') {
      out[outKey] = value.replace(/^#\/definitions\//, '#/$defs/');
      continue;
    }
    out[outKey] = rewriteNode(value, childIsPropertyMap);
  }

  if (inPropertyMap) return out;

  // Fix 5: nullable anyOf collapse — before type-defaulting, so the
  // surviving branch keeps its own type.
  if (Array.isArray(out.anyOf) && out.default === null) {
    const branches = out.anyOf.filter(
      (b) => !(isPlainObject(b) && b.type === 'null' && Object.keys(b).length === 1),
    );
    if (branches.length === 1 && isPlainObject(branches[0])) {
      const only = branches[0] as Record<string, unknown>;
      delete out.anyOf;
      delete out.default;
      for (const [k, v] of Object.entries(only)) if (!(k in out)) out[k] = v;
    }
  }

  // Fix 2: object-shaped node without a type.
  const looksLikeObjectSchema =
    isPlainObject(out.properties) || Array.isArray(out.required) || isPlainObject(out.patternProperties);
  if ((out.type === undefined || out.type === null) && looksLikeObjectSchema) {
    out.type = 'object';
  }

  if (out.type === 'object') {
    // Fix 3: required without properties dangles.
    if (!isPlainObject(out.properties)) out.properties = {};
    // Fix 4: prune required to actually-present properties.
    if (Array.isArray(out.required)) {
      const props = out.properties as Record<string, unknown>;
      const pruned = out.required.filter((r) => typeof r === 'string' && r in props);
      if (pruned.length > 0) out.required = pruned;
      else delete out.required;
    }
  }

  return out;
}

export interface NamedTool {
  /** Raw upstream tool name (what tools/call expects). */
  rawName: string;
  /** Full model-visible name `mcp__<server>__<sanitized>`. */
  fullName: string;
}

export interface NameBuildResult {
  accepted: NamedTool[];
  skipped: Array<{ rawName: string; reason: string }>;
}

/**
 * Build model-visible names for one server's tool list. Sanitizes to the
 * API charset, enforces the 64-char ceiling (skip, don't truncate —
 * truncation manufactures new collisions), and fails CLOSED on
 * collisions: every ambiguous entry is skipped rather than picking an
 * arbitrary handler (Hermes rule).
 */
export function buildToolNames(server: string, rawNames: string[]): NameBuildResult {
  const accepted: NamedTool[] = [];
  const skipped: Array<{ rawName: string; reason: string }> = [];
  const byFullName = new Map<string, string[]>();

  for (const rawName of rawNames) {
    const sanitized = rawName.replace(TOOL_NAME_SAFE, '_');
    const fullName = `mcp__${server}__${sanitized}`;
    const list = byFullName.get(fullName);
    if (list) list.push(rawName);
    else byFullName.set(fullName, [rawName]);
  }

  for (const [fullName, raws] of byFullName) {
    const first = raws[0];
    if (first === undefined) continue;
    if (raws.length > 1) {
      for (const rawName of raws) {
        skipped.push({ rawName, reason: `name collision after sanitizing (${fullName})` });
      }
      continue;
    }
    if (fullName.length > MAX_TOOL_NAME_CHARS) {
      skipped.push({ rawName: first, reason: `full name exceeds ${MAX_TOOL_NAME_CHARS} chars` });
      continue;
    }
    accepted.push({ rawName: first, fullName });
  }

  return { accepted, skipped };
}
