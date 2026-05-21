// somora_docs_* — read-only access to somora's own project docs.
// Lets the agent answer "where do my persona files live?" / "what
// goes into agent.yaml?" by RTFM-ing somora's own documentation
// instead of hallucinating from training data.
//
// Why dedicated tools instead of file_read with a path-whitelist:
//   - works regardless of how somora is installed/run (we resolve from
//     the running module's URL, not from cwd)
//   - listable: somora_docs_list shows the agent the available topics
//     before it commits a slot to reading one
//   - clear description: "read somora's own documentation" steers the
//     agent toward this tool over generic file_read for self-questions

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ToolDefinition } from '../types.ts';

// Resolve the somora repo root from this file's location.
//   src/tools/docs/tools.ts → repo root is up four dirs.
// Works whether the server runs via tsx (typical) or after a build:
// the relative-path math is identical because we don't bundle.
const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), '..', '..', '..');
const DOCS_ROOT = join(REPO_ROOT, 'docs');

// Snapshot the available topic names at module load so we can surface
// them as a JSON-schema `enum` on `somora_docs_read.topic`. The model
// sees the exact valid set in the tool schema and stops guessing names
// like "config" that don't exist. Walks one level into subdirs so
// `research/tool-architecture` etc. are included. Falls back to an
// empty list (= no enum constraint) if the scan fails for any reason —
// degrading gracefully is preferred to crashing the server boot.
import { readdirSync } from 'node:fs';
function snapshotDocsTopics(): string[] {
  try {
    const out: string[] = [];
    const top = readdirSync(DOCS_ROOT, { withFileTypes: true });
    for (const e of top) {
      if (e.isFile() && e.name.endsWith('.md')) {
        out.push(e.name.replace(/\.md$/, ''));
      } else if (e.isDirectory()) {
        try {
          const sub = readdirSync(join(DOCS_ROOT, e.name), { withFileTypes: true });
          for (const f of sub) {
            if (f.isFile() && f.name.endsWith('.md')) {
              out.push(`${e.name}/${f.name.replace(/\.md$/, '')}`);
            }
          }
        } catch {
          /* sub-scan failure: skip this dir, keep others */
        }
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}
const DOCS_TOPICS = snapshotDocsTopics();

interface DocsListEntry {
  topic: string;
  path: string;
  description: string;
}

const ListInput = z
  .object({
    subdir: z
      .string()
      .optional()
      .describe('Optional sub-folder under docs/ (e.g. "research"). Omit for the top-level list.'),
  })
  .strict();

export const somoraDocsList: ToolDefinition<z.infer<typeof ListInput>> = {
  name: 'somora_docs_list',
  toolset: 'memory', // bundled with memory-class read tools for grouping
  description:
    'List available somora documentation topics. Each entry has a `topic` (use this with ' +
    '`somora_docs_read`) and a one-line description from the doc\'s first heading. Use this ' +
    'before answering questions about how somora works (config schema, agent layout, memory ' +
    'system, dream mode, /thinking, /verbose, tool architecture). Optional `subdir` lists ' +
    'a sub-folder like "research" instead of the top level.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      subdir: { type: 'string', description: 'Optional sub-folder under docs/ to list.' },
    },
    additionalProperties: false,
  },
  async handler(input): Promise<{ count: number; topics: DocsListEntry[] }> {
    const dir = input.subdir ? safeJoin(DOCS_ROOT, input.subdir) : DOCS_ROOT;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch (err) {
      throw new Error(`somora_docs_list: cannot read '${input.subdir ?? '(root)'}': ${(err as Error).message}`);
    }
    const out: DocsListEntry[] = [];
    for (const e of entries) {
      const name = String(e.name);
      if (e.isFile() && name.endsWith('.md')) {
        const fullPath = join(dir, name);
        const topic = (input.subdir ? `${input.subdir}/${name}` : name).replace(/\.md$/, '');
        const description = await firstHeading(fullPath);
        out.push({ topic, path: relativeToDocs(fullPath), description });
      } else if (e.isDirectory() && !name.startsWith('.')) {
        // Surface sub-dirs as listable topics (call with subdir=...).
        const childTopic = input.subdir ? `${input.subdir}/${name}` : name;
        out.push({
          topic: `${childTopic}/`,
          path: relativeToDocs(join(dir, name)),
          description: `(sub-folder — call somora_docs_list with subdir="${childTopic}" to expand)`,
        });
      }
    }
    return { count: out.length, topics: out.sort((a, b) => a.topic.localeCompare(b.topic)) };
  },
};

const ReadInput = z
  .object({
    topic: z
      .string()
      .min(1)
      .describe('Topic name from somora_docs_list, e.g. "agents", "memory", "research/tool-architecture".'),
  })
  .strict();

export const somoraDocsRead: ToolDefinition<z.infer<typeof ReadInput>> = {
  name: 'somora_docs_read',
  toolset: 'memory',
  description:
    'Read the full contents of a somora documentation topic. Returns Markdown verbatim. ' +
    'Topic name comes from `somora_docs_list`; .md extension is implicit. ' +
    'Use this when the user asks how somora works, how to configure something, where files ' +
    'live, what a slash command does — answer from the docs, not from training data.',
  inputSchema: ReadInput,
  jsonSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Topic name (no .md extension). Sub-paths use `/`, e.g. "research/tool-architecture".',
        // Empty enum would invalidate every input — only attach when
        // the scan found at least one topic.
        ...(DOCS_TOPICS.length > 0 ? { enum: DOCS_TOPICS } : {}),
      },
    },
    required: ['topic'],
    additionalProperties: false,
  },
  // Docs can be long (research/tool-architecture is ~525 lines). Bigger
  // cap than usual; if the model needs more it can re-read selectively
  // via section search later.
  maxResultSizeChars: 200_000,
  async handler(input): Promise<{ topic: string; path: string; content: string; bytes: number }> {
    const fileName = input.topic.endsWith('.md') ? input.topic : `${input.topic}.md`;
    const fullPath = safeJoin(DOCS_ROOT, fileName);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf8');
    } catch (err) {
      // Surface the valid topic list inline so the model can recover
      // without an extra somora_docs_list round-trip.
      const known = DOCS_TOPICS.length > 0 ? ` Known topics: ${DOCS_TOPICS.join(', ')}.` : '';
      throw new Error(
        `somora_docs_read: topic '${input.topic}' not found (${(err as Error).message}).${known}`,
      );
    }
    return {
      topic: input.topic,
      path: relativeToDocs(fullPath),
      content,
      bytes: content.length,
    };
  },
};

/**
 * Path-traversal guard for inputs that get joined under DOCS_ROOT. Any
 * `..` or absolute prefix throws — prevents escapes like
 * `topic: '../../etc/shadow'`.
 */
function safeJoin(root: string, rel: string): string {
  const normalized = rel.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error(`somora_docs: path traversal not allowed in '${rel}'`);
  }
  const full = resolve(root, normalized);
  if (!full.startsWith(root + sep) && full !== root) {
    throw new Error(`somora_docs: '${rel}' escapes the docs root`);
  }
  return full;
}

function relativeToDocs(absPath: string): string {
  if (absPath === DOCS_ROOT) return 'docs/';
  if (absPath.startsWith(DOCS_ROOT + sep)) {
    return 'docs/' + absPath.slice(DOCS_ROOT.length + 1).replace(/\\/g, '/');
  }
  return absPath;
}

async function firstHeading(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return '';
    // Read just the first ~1 KB — first-line lookup, no need for full file.
    const fd = await readFile(path, 'utf8');
    const lines = fd.split('\n', 30);
    for (const line of lines) {
      const m = line.match(/^#{1,3}\s+(.+?)\s*$/);
      if (m) return m[1]!.trim();
    }
    return '';
  } catch {
    return '';
  }
}

export function somoraDocsTools(): ToolDefinition[] {
  return [somoraDocsList, somoraDocsRead] as ToolDefinition[];
}
