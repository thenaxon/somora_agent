// file_* tool family — read / write / patch / search across local
// filesystem and named SSH resources, dispatched via the `target`
// parameter.
//
// Architecture:
//   - target='local' (default) → local backend (fs + spawn rg)
//   - target=<resource-name>   → resource visibility check, then SSH
//                                pool + SFTP / remote-exec'd rg
//
// Path-blacklist (write side) blocks system dirs, credential stores,
// somora's internal state, and other agents' private dirs. The
// agent's OWN persona dir and the global config are intentionally
// writable so the agent can self-edit.

import { z } from 'zod';
import type { ContentBlock } from '../../multimodal/blocks.ts';
import { resolveVisibleResourceFresh } from '../resources/visibility.ts';
import type { MultimodalToolResult, ToolContext, ToolDefinition } from '../types.ts';
import { localList, localPatch, localRead, localSearch, localWrite } from './local.ts';
import { remoteList, remotePatch, remoteRead, remoteSearch, remoteWrite } from './remote.ts';

// ─────────────────────────────────────────────────────────────────────
// Multimodal helpers for file_read polymorph (image, PDF)
// ─────────────────────────────────────────────────────────────────────

/** Load an image file and wrap as a MultimodalToolResult. Capability-
 *  gates on the active model — if the model can't see images, error
 *  with a pointer to analyze_file. */
async function readImageAsContentBlock(
  absolutePath: string,
  mimeType: string,
  ctx: ToolContext,
): Promise<MultimodalToolResult> {
  if (!ctx.activeModel || !ctx.activeModel.model.capabilities.includes('image')) {
    throw new Error(
      `file_read: '${absolutePath}' is ${mimeType} but the active model ` +
        `${ctx.activeModel ? `'${ctx.activeModel.providerName}/${ctx.activeModel.modelId}'` : '(unknown)'} ` +
        `lacks 'image' capability. Use analyze_file({path:"${absolutePath}"}) ` +
        `to dispatch to the configured vision worker, or switch to a ` +
        `vision-capable model.`,
    );
  }
  const { loadAttachment } = await import('../../multimodal/load.ts');
  const att = await loadAttachment(absolutePath);
  return {
    _somoraMultimodal: true,
    contentBlocks: [
      {
        type: 'image',
        source: {
          kind: 'base64',
          mediaType: att.mime.mimeType,
          data: att.bytes.toString('base64'),
        },
      },
    ],
  };
}

/** Render a PDF to per-page PNG images, return as MultimodalToolResult.
 *  MCP's tool-result content union has no `document` type, so PDFs
 *  reach the model only as image-arrays. Caps at 20 pages by default. */
async function readPdfAsContentBlocks(
  absolutePath: string,
  ctx: ToolContext,
): Promise<MultimodalToolResult> {
  if (!ctx.activeModel || !ctx.activeModel.model.capabilities.includes('image')) {
    throw new Error(
      `file_read: '${absolutePath}' is a PDF but the active model ` +
        `${ctx.activeModel ? `'${ctx.activeModel.providerName}/${ctx.activeModel.modelId}'` : '(unknown)'} ` +
        `lacks 'image' capability (PDFs are rendered to PNG-pages and ` +
        `delivered as images). Use analyze_file({path:"${absolutePath}"}) ` +
        `to dispatch to the configured vision worker, or switch to a ` +
        `vision-capable model.`,
    );
  }
  const { renderPdfToPngs } = await import('../../multimodal/pdf-render.ts');
  const result = await renderPdfToPngs(absolutePath, { maxPages: 20, scale: 1.5 });
  if (result.pages.length === 0) {
    throw new Error(`file_read: PDF '${absolutePath}' produced no renderable pages.`);
  }
  const blocks: ContentBlock[] = result.pages.map((data) => ({
    type: 'image',
    source: { kind: 'base64', mediaType: 'image/png', data },
  }));
  if (result.truncated) {
    blocks.unshift({
      type: 'text',
      text:
        `[file_read: PDF has ${result.totalPages} pages; rendered first ${result.pages.length} as images. ` +
        `Use analyze_file for full-document text analysis, or read further pages with a tighter range.]`,
    });
  }
  return { _somoraMultimodal: true, contentBlocks: blocks };
}

// ─────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────

const TargetField = z
  .string()
  .min(1)
  .default('local')
  .describe(
    'Where to perform the operation. "local" (default) = the somora server\'s filesystem. ' +
      'Otherwise the name of a configured resource from `resource_list`. ' +
      'Note: file_search requires `rg` (ripgrep) on the target machine.',
  );

async function resolveSshTarget(args: {
  ctx: { agent: string };
  target: string;
}) {
  // Fresh config so file_*-with-target picks up newly-added resource
  // entries without a server restart (parity with resource_list /
  // resource_test). ctx.config is no longer needed here — the lazy
  // hot-reload cache in config/loader.ts handles it.
  const resource = await resolveVisibleResourceFresh(args.ctx.agent, args.target);
  if (!resource) {
    throw new Error(`file_*: target '${args.target}' is not a configured resource (or denied for this agent). Use resource_list to see available targets.`);
  }
  if (resource.type !== 'ssh') {
    throw new Error(`file_*: resource '${args.target}' has unsupported type '${resource.type}'`);
  }
  return resource;
}

// ─────────────────────────────────────────────────────────────────────
// file_read
// ─────────────────────────────────────────────────────────────────────

const ReadInput = z
  .object({
    path: z
      .string()
      .min(1)
      .describe('File path. Relative paths resolve against the workspace dir; absolute paths pass through. ~ expands to $HOME on local.'),
    target: TargetField,
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Skip the first N lines (0-indexed). Use with `limit` to page through large files.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Max number of lines to return. Combine with offset for pagination.'),
  })
  .strict();

export const fileRead: ToolDefinition<z.infer<typeof ReadInput>> = {
  name: 'file_read',
  toolset: 'file',
  description:
    'Read a file from the local filesystem or a remote resource. Polymorphic — text files ' +
    'return content paginated; images and PDFs return as native content blocks the model ' +
    'can see directly (when the active model has `image` capability). Relative paths resolve ' +
    'against the agent\'s workspace dir; absolute paths pass through. Use offset+limit to ' +
    'page through large text files (single read caps at 200k chars). ' +
    'Use this INSTEAD of running `cat`, `head`, or `tail` via exec — file_read paginates safely, ' +
    'enforces the read-blacklist, and never gets caught by shell quoting. ' +
    '\n\n' +
    'Multimodal behavior (local files only):\n' +
    '  - PNG / JPEG / WebP / GIF → returned as image content block. Active model must ' +
    'have `image` capability; if not, you get an error pointing at `analyze_file`.\n' +
    '  - PDF → each page rendered to PNG (max 20 pages by default), returned as ' +
    'image-array. Same `image`-capability gate. Token cost: ~1300 tokens per page on ' +
    'Anthropic models — for large PDFs prefer `analyze_file` (dispatches to a vision ' +
    'worker model and returns a text description).\n' +
    '  - Unknown binary → error with a hint to inspect with `exec` first.\n\n' +
    'When the active model lacks `image` capability OR you prefer a token-cheap text ' +
    'description over raw bytes in context, use `analyze_file` instead.',
  inputSchema: ReadInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to workspace, or absolute).' },
      target: { type: 'string', description: 'local (default) or a resource name from resource_list.', default: 'local' },
      offset: { type: 'integer', minimum: 0, description: 'Skip the first N lines (0-indexed).' },
      limit: { type: 'integer', minimum: 1, description: 'Max lines to return.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  maxResultSizeChars: 250_000,
  async handler(input, ctx) {
    if (input.target === 'local') {
      // MIME-pre-check for local reads. Three branches based on
      // detected file kind:
      //   - text → existing pagination logic
      //   - image → return MultimodalToolResult with image content
      //     block (active model needs `image` capability — error with
      //     pointer to analyze_file otherwise)
      //   - pdf → render pages to PNG, return image-array
      //     (MultimodalToolResult). Same capability gate.
      //   - unknown → clear error explaining the situation
      // Remote reads skip this for now — would require an extra SFTP
      // round-trip + remote PDF rendering; v2 work.
      try {
        const { detectMimeFromPath } = await import('../../multimodal/mime.ts');
        const { resolveLocalPath } = await import('./policy.ts');
        const { absolute } = await resolveLocalPath(input.path, ctx.agent, ctx.config);
        const mime = await detectMimeFromPath(absolute);
        if (mime.kind === 'image') {
          return await readImageAsContentBlock(absolute, mime.mimeType, ctx);
        }
        if (mime.kind === 'pdf') {
          return await readPdfAsContentBlocks(absolute, ctx);
        }
        if (mime.kind === 'unknown') {
          throw new Error(
            `file_read: '${input.path}' has no recognized text or known-binary signature ` +
              `(detected ${mime.mimeType}). If it's actually text, the file may have an ` +
              `unusual encoding; if it's binary, use exec to inspect the type via 'file' first.`,
          );
        }
      } catch (err) {
        // Re-throw our own clear errors; let stat-failures (file
        // missing, no permission) fall through to localRead which has
        // its own error path that already produces good messages.
        const msg = (err as Error).message;
        if (msg.startsWith('file_read:')) throw err;
      }
      return localRead({
        path: input.path,
        agent: ctx.agent,
        config: ctx.config,
        offset: input.offset,
        limit: input.limit,
      });
    }
    const resource = await resolveSshTarget({ ctx, target: input.target });
    return remoteRead({
      resourceName: input.target,
      resource,
      path: input.path,
      offset: input.offset,
      limit: input.limit,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// file_write
// ─────────────────────────────────────────────────────────────────────

const WriteInput = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    target: TargetField,
    mode: z.enum(['create', 'overwrite', 'append']).default('overwrite'),
  })
  .strict();

export const fileWrite: ToolDefinition<z.infer<typeof WriteInput>> = {
  name: 'file_write',
  toolset: 'file',
  description:
    'Write a text file to the local filesystem or a remote resource. Atomic (tmp + rename). ' +
    'Modes: `create` (refuses if exists), `overwrite` (default — replaces fully), `append` ' +
    '(adds to existing, creates if missing). Parent dirs auto-created. ' +
    'Path-blacklist blocks system dirs (/etc, /usr, /sys, ...), credential stores ' +
    '(~/.ssh, ~/.gnupg, ~/.aws), other agents\' dirs, and somora\'s own session/index files. ' +
    'The agent\'s OWN persona files (~/.somora/agents/<self>/) and the global config ' +
    '(~/.somora/config.yaml) are writable — use this to self-edit. ' +
    'Use this INSTEAD of `echo > file` or heredoc-via-exec — file_write is binary-safe, ' +
    'has no quoting issues, and works the same locally and over SSH (via SFTP).',
  inputSchema: WriteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Destination path (relative to workspace, or absolute).' },
      content: { type: 'string', description: 'Full file content.' },
      target: { type: 'string', description: 'local (default) or a resource name.', default: 'local' },
      mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: 'Default: overwrite.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    if (input.target === 'local') {
      return localWrite({
        path: input.path,
        content: input.content,
        agent: ctx.agent,
        config: ctx.config,
        mode: input.mode,
      });
    }
    const resource = await resolveSshTarget({ ctx, target: input.target });
    return remoteWrite({
      resourceName: input.target,
      resource,
      path: input.path,
      content: input.content,
      mode: input.mode,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// file_patch
// ─────────────────────────────────────────────────────────────────────

const PatchInput = z
  .object({
    path: z.string().min(1),
    target: TargetField,
    old_string: z
      .string()
      .min(1)
      .describe('Exact text to find. Must be unique in the file unless replace_all=true. Include surrounding context to disambiguate.'),
    new_string: z.string().describe('Replacement text. Empty string deletes the matched range.'),
    replace_all: z.boolean().default(false),
  })
  .strict();

export const filePatch: ToolDefinition<z.infer<typeof PatchInput>> = {
  name: 'file_patch',
  toolset: 'file',
  description:
    'Find-and-replace edit on a text file. Finds `old_string` and replaces with `new_string`. ' +
    'Match must be byte-exact (whitespace counts). When `old_string` appears more than once, ' +
    'either include enough surrounding context to make it unique, or pass `replace_all=true`. ' +
    'Atomic write. Use this INSTEAD of `sed -i` via exec — no regex-quoting issues, no risk ' +
    'of partial-write corruption, no platform-specific sed flags.',
  inputSchema: PatchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit.' },
      target: { type: 'string', description: 'local (default) or resource name.', default: 'local' },
      old_string: { type: 'string', description: 'Exact text to find. Must be unique unless replace_all=true.' },
      new_string: { type: 'string', description: 'Replacement text. Empty deletes the match.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    if (input.target === 'local') {
      return localPatch({
        path: input.path,
        agent: ctx.agent,
        config: ctx.config,
        oldString: input.old_string,
        newString: input.new_string,
        replaceAll: input.replace_all,
      });
    }
    const resource = await resolveSshTarget({ ctx, target: input.target });
    return remotePatch({
      resourceName: input.target,
      resource,
      path: input.path,
      oldString: input.old_string,
      newString: input.new_string,
      replaceAll: input.replace_all,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// file_search
// ─────────────────────────────────────────────────────────────────────

const SearchInput = z
  .object({
    pattern: z.string().min(1).describe('Regex pattern (ripgrep syntax — Rust regex).'),
    target: TargetField,
    path: z
      .string()
      .optional()
      .describe('Search root. Relative paths resolve against workspace; default is the workspace itself.'),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const fileSearch: ToolDefinition<z.infer<typeof SearchInput>> = {
  name: 'file_search',
  toolset: 'file',
  description:
    'Search file contents recursively for a regex pattern. Powered by ripgrep — fast, ' +
    'respects .gitignore by default. Returns hits with path/line/text. ' +
    'Use this INSTEAD of `grep -r`, `find ... -exec grep`, or piping through exec — file_search ' +
    'gives structured results, caps output safely, and works the same locally and over SSH. ' +
    'Requires `rg` on the target machine (install via brew/apt/dnf if missing).',
  inputSchema: SearchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern.' },
      target: { type: 'string', description: 'local (default) or resource name.', default: 'local' },
      path: { type: 'string', description: 'Search root (default: workspace).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max hits (default 50).' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  maxResultSizeChars: 200_000,
  async handler(input, ctx) {
    if (input.target === 'local') {
      return localSearch({
        pattern: input.pattern,
        agent: ctx.agent,
        config: ctx.config,
        path: input.path,
        limit: input.limit,
      });
    }
    const resource = await resolveSshTarget({ ctx, target: input.target });
    return remoteSearch({
      resourceName: input.target,
      resource,
      pattern: input.pattern,
      path: input.path,
      limit: input.limit,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// file_list
// ─────────────────────────────────────────────────────────────────────

const ListInput = z
  .object({
    path: z
      .string()
      .min(1)
      .describe('Directory to list. Relative paths resolve against the workspace; absolute paths pass through.'),
    target: TargetField,
    recursive: z
      .boolean()
      .default(false)
      .describe('Walk subdirectories. Default false (top-level only).'),
    sortBy: z
      .enum(['mtime', 'name', 'size'])
      .default('name')
      .describe('Sort order. mtime = newest first, size = largest first, name = lexicographic.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(200)
      .describe('Max entries to return after sort. Default 200, hard cap 5000.'),
    glob: z
      .string()
      .min(1)
      .optional()
      .describe('Filter pattern. Supports *, **, ?. Without `/` matches against basename; with `/` matches against path relative to listing root. e.g. "*.md" or "**/notes/*.md".'),
  })
  .strict();

export const fileList: ToolDefinition<z.infer<typeof ListInput>> = {
  name: 'file_list',
  toolset: 'file',
  description:
    'List directory contents with type/size/mtime/ctime per entry. Use this to answer questions ' +
    'like "what is the newest file in X?" (sortBy: mtime), "find recently changed configs", ' +
    '"are there empty files in this dir?", "which days between N and M have a daily-note?" — anything ' +
    'that needs a directory enumeration rather than content search. ' +
    'Output is structured (NOT shell-formatted ls -l): each entry has path, type (file/dir/other), ' +
    'size in bytes, mtime+ctime as ms-since-epoch. ' +
    'Use this INSTEAD of running `ls`, `find`, or `stat` via exec — file_list is path-blacklist-aware ' +
    'and works against remote resources via the same `target` parameter as the rest of file_*. ' +
    'Dotfiles are skipped by default; pass an explicit glob like ".*" to include them.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (relative to workspace, or absolute).' },
      target: { type: 'string', description: 'local (default) or a resource name.', default: 'local' },
      recursive: { type: 'boolean', default: false, description: 'Walk subdirectories.' },
      sortBy: { type: 'string', enum: ['mtime', 'name', 'size'], default: 'name' },
      limit: { type: 'integer', minimum: 1, maximum: 5000, default: 200 },
      glob: { type: 'string', description: 'Filter pattern. *, **, ? supported.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  maxResultSizeChars: 250_000,
  async handler(input, ctx) {
    if (input.target === 'local') {
      return localList({
        path: input.path,
        agent: ctx.agent,
        config: ctx.config,
        recursive: input.recursive,
        sortBy: input.sortBy,
        limit: input.limit,
        ...(input.glob ? { glob: input.glob } : {}),
      });
    }
    const resource = await resolveSshTarget({ ctx, target: input.target });
    return remoteList({
      resourceName: input.target,
      resource,
      path: input.path,
      recursive: input.recursive,
      sortBy: input.sortBy,
      limit: input.limit,
      ...(input.glob ? { glob: input.glob } : {}),
    });
  },
};

export function fileTools(): ToolDefinition[] {
  return [fileRead, fileWrite, filePatch, fileSearch, fileList] as ToolDefinition[];
}
