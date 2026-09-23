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
import { lspAfterWrite, lspTouch } from './lsp-hook.ts';
import { WRITE_SCOPE_QUESTION_TIMEOUT_MS } from './write-scope.ts';
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
  // Same cap as chat attachments (config.attachments.maxImageBytes) —
  // the loader's own default is 5 MB, which a 2K image-generation
  // output exceeds; that error used to fall through to the TEXT reader
  // and dump PNG bytes into the model context (2026-09-05 report).
  const att = await loadAttachment(absolutePath, {
    maxImageBytes: ctx.config.attachments?.maxImageBytes,
  });
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
        `Read further pages with a tighter range.]`,
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
      .describe('Skip the first N lines (0-based): offset=2000 starts at line 2001. Use the `next_offset` a truncated read returns.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Max number of LINES to return (not bytes). Default 2000. When the result truncates, ' +
          'the response includes `next_offset` — pass that as `offset` on the next call to continue paging.',
      ),
  })
  .strict();

export const fileRead: ToolDefinition<z.infer<typeof ReadInput>> = {
  name: 'file_read',
  toolset: 'file',
  description:
    'Read a file from the local filesystem or a remote resource. Text comes back with every ' +
    'line prefixed by its 1-based number as `12: text` — cite locations as path:line, and when ' +
    'you copy lines into file_patch, copy only the text AFTER the `N: ` prefix. Reads up to ' +
    '2000 lines per call (set `limit` for more or less); a line longer than 2000 chars is cut ' +
    'with a marker. The result ends with `summary`: "End of file (N lines)." when you have seen ' +
    'everything, or "Showing lines a-b of N. Continue with offset=b." — then call again with ' +
    'that offset. A missing file names the closest existing names in its directory. ' +
    'Images and PDFs return as native content blocks the model can see directly (when the ' +
    'active model has `image` capability). Relative paths resolve against the agent\'s ' +
    'workspace dir; absolute paths pass through. ' +
    'Use this INSTEAD of running `cat`, `head`, or `tail` via exec — file_read paginates safely, ' +
    'enforces the read-blacklist, and never gets caught by shell quoting. ' +
    '\n\n' +
    'Multimodal behavior (local files only):\n' +
    '  - PNG / JPEG / WebP / GIF → returned as image content block. Active model must ' +
    'have `image` capability; if not, you get an error pointing at `analyze_file`.\n' +
    '  - PDF → each page rendered to PNG (max 20 pages by default), returned as ' +
    'image-array. Same `image`-capability gate. Token cost: ~1300 tokens per page on ' +
    'Anthropic models.\n' +
    '  - Unknown binary → error with a hint to inspect with `exec` first.\n\n' +
    'If your model can see images, look yourself — that is more reliable than a ' +
    'second-hand description. `analyze_file` exists for models that cannot, and is only ' +
    'offered to those.',
  inputSchema: ReadInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to workspace, or absolute).' },
      target: { type: 'string', description: 'local (default) or a resource name from resource_list.', default: 'local' },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Skip the first N lines (0-based): offset=2000 starts at line 2001. Use the `next_offset` a truncated read returns.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description:
          'Max LINES (not bytes), default 2000. When the response is truncated, use the returned `next_offset` to page.',
      },
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
      // Read policy FIRST, outside the try below: the image/PDF branch
      // returns file content without ever reaching localRead (which has
      // its own check), so an image or PDF under a blocked directory
      // used to be readable.
      {
        const { resolveLocalPath, assertReadAllowed } = await import('./policy.ts');
        const { absolute } = await resolveLocalPath(input.path, ctx.agent, ctx.config, ctx.session);
        // Pre-warm the language server for a builder's read (docs/lsp.md).
        lspTouch(ctx, absolute);
        await assertReadAllowed(absolute);
      }
      try {
        const { detectMimeFromPath } = await import('../../multimodal/mime.ts');
        const { resolveLocalPath } = await import('./policy.ts');
        const { absolute } = await resolveLocalPath(input.path, ctx.agent, ctx.config, ctx.session);
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
        // Multimodal loader/renderer errors (size cap, unreadable PDF)
        // are final too: an image or PDF must never be re-read as text.
        if (msg.startsWith('multimodal:') || /\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(input.path)) {
          throw new Error(`file_read: ${msg}`);
        }
      }
      return localRead({
        path: input.path,
        agent: ctx.agent,
        session: ctx.session,
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
    path: z
      .string()
      .min(1)
      .describe(
        'Destination path. Relative paths resolve against the workspace dir itself — do NOT ' +
          'prefix them with the workspace folder name (that nests a copy inside the workspace). ' +
          'Absolute paths pass through.',
      ),
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
    '(~/.ssh, ~/.gnupg, ~/.aws) and somora\'s own session/index files. A persona file of any agent ' +
    '(AGENTS.md, SOUL.md, USER.md, VOICE.md, agent.yaml) is copied to a timestamped backup before every write. ' +
    'The agent\'s OWN persona files (~/.somora/agents/<self>/) and the global config ' +
    '(~/.somora/config.yaml) are writable — use this to self-edit. ' +
    'Use this INSTEAD of `echo > file` or heredoc-via-exec — file_write is binary-safe, ' +
    'has no quoting issues, and works the same locally and over SSH (via SFTP).',
  // Long enough for the write-scope question a builder's write may raise
  // in attended mode (docs/builder.md): the person has five minutes.
  defaultTimeoutMs: WRITE_SCOPE_QUESTION_TIMEOUT_MS + 30_000,
  inputSchema: WriteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Destination path. Relative paths resolve against the workspace dir itself — do NOT ' +
          'prefix them with the workspace folder name (that nests a copy inside the workspace). ' +
          'Absolute paths pass through.',
      },
      content: { type: 'string', description: 'Full file content.' },
      target: { type: 'string', description: 'local (default) or a resource name.', default: 'local' },
      mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: 'Default: overwrite.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    if (input.target === 'local') {
      const result = await localWrite({
        path: input.path,
        content: input.content,
        agent: ctx.agent,
        session: ctx.session,
        config: ctx.config,
        mode: input.mode,
      });
      // A builder gets the language server's verdict on the file (docs/lsp.md).
      const lsp = await lspAfterWrite(ctx, result.path);
      return lsp ? { ...result, ...lsp } : result;
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
      .describe(
        'The text to replace, copied from the file as file_read shows it but WITHOUT the `N: ` line-number prefix. ' +
          'Must be unique in the file unless replace_all=true — include surrounding lines to disambiguate.',
      ),
    new_string: z.string().describe('Replacement text (must differ from old_string). Empty string deletes the matched range.'),
    replace_all: z.boolean().default(false),
  })
  .strict();

export const filePatch: ToolDefinition<z.infer<typeof PatchInput>> = {
  name: 'file_patch',
  toolset: 'file',
  description:
    'Replace `old_string` with `new_string` in a text file. Read the file first and copy the ' +
    'lines exactly, keeping their indentation and WITHOUT the `N: ` line-number prefix file_read ' +
    'adds. An exact match always wins; when the text differs only in whitespace, indentation, ' +
    'line endings or escaped characters, the closest unique block is used and the result says ' +
    'so (`strategy`, `note`). The result carries a `diff` of the changed lines with their line ' +
    'numbers — check it. Fails when old_string is not found, matches more than one place (add ' +
    'context or pass `replace_all=true`), or the closest match spans far more than old_string. ' +
    'Atomic write. Use this INSTEAD of `sed -i` via exec — no regex-quoting issues, no risk ' +
    'of partial-write corruption, no platform-specific sed flags.',
  // Long enough for the write-scope question a builder's write may raise
  // in attended mode (docs/builder.md): the person has five minutes.
  defaultTimeoutMs: WRITE_SCOPE_QUESTION_TIMEOUT_MS + 30_000,
  inputSchema: PatchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit.' },
      target: { type: 'string', description: 'local (default) or resource name.', default: 'local' },
      old_string: {
        type: 'string',
        description:
          'Text to replace, copied from the file WITHOUT the `N: ` line-number prefix. Must be unique unless replace_all=true.',
      },
      new_string: { type: 'string', description: 'Replacement text (must differ). Empty deletes the match.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    if (input.target === 'local') {
      const result = await localPatch({
        path: input.path,
        agent: ctx.agent,
        session: ctx.session,
        config: ctx.config,
        oldString: input.old_string,
        newString: input.new_string,
        replaceAll: input.replace_all,
      });
      const lsp = await lspAfterWrite(ctx, result.path);
      return lsp ? { ...result, ...lsp } : result;
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
      .describe('Search root (directory or single file). Relative paths resolve against workspace; default is the workspace itself.'),
    limit: z.number().int().min(1).max(500).optional(),
    include: z
      .string()
      .min(1)
      .optional()
      .describe('Only search files matching this glob, e.g. "*.ts", "*.{ts,tsx}", "src/**", "!*.test.*" (ripgrep -g).'),
    case_insensitive: z.boolean().optional().describe('Ignore case (default false).'),
    context: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('Lines of context before and after each hit (0-5, default 0) — returned as `before`/`after` on the hit.'),
    files_only: z
      .boolean()
      .optional()
      .describe('Return only the paths of files that contain a match (`files`), no lines. Cheap way to find where something lives.'),
  })
  .strict();

export const fileSearch: ToolDefinition<z.infer<typeof SearchInput>> = {
  name: 'file_search',
  toolset: 'file',
  description:
    'Search file contents recursively for a regex pattern (ripgrep, respects .gitignore). ' +
    'Filter with `include` (glob like "*.ts" or "src/**"), `case_insensitive`, and get ' +
    '`context` lines around each hit or `files_only` for just the paths. Each hit has ' +
    'path, line (1-based), col and `text` — the whole line up to ~500 chars, longer lines ' +
    'windowed around the match (`…` marks the cut, `truncated: true`). Results stop at `limit` ' +
    'hits (default 50) and an overall text budget; `truncated: true` means there was more — ' +
    'narrow the pattern, path or include. ' +
    'Use this INSTEAD of `grep -r`, `find ... -exec grep`, or piping through exec — file_search ' +
    'gives structured results, caps output safely, and works the same locally and over SSH. ' +
    'Requires `rg` on the target machine (install via brew/apt/dnf if missing).',
  inputSchema: SearchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern (ripgrep / Rust syntax).' },
      target: { type: 'string', description: 'local (default) or resource name.', default: 'local' },
      path: { type: 'string', description: 'Search root: directory or single file (default: workspace).' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description: 'Max hits (default 50). `truncated: true` when this or the text budget was reached.',
      },
      include: {
        type: 'string',
        description: 'Only files matching this glob: "*.ts", "*.{ts,tsx}", "src/**", "!*.test.*".',
      },
      case_insensitive: { type: 'boolean', description: 'Ignore case. Default false.' },
      context: {
        type: 'integer',
        minimum: 0,
        maximum: 5,
        description: 'Context lines before/after each hit (0-5). Returned as `before`/`after` arrays.',
      },
      files_only: { type: 'boolean', description: 'Only return matching file paths in `files`.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  maxResultSizeChars: 200_000,
  async handler(input, ctx) {
    const opts = {
      include: input.include,
      caseInsensitive: input.case_insensitive,
      context: input.context,
      filesOnly: input.files_only,
    };
    if (input.target === 'local') {
      return localSearch({
        pattern: input.pattern,
        agent: ctx.agent,
        session: ctx.session,
        config: ctx.config,
        path: input.path,
        limit: input.limit,
        ...opts,
      });
    }
    const resource = await resolveSshTarget({ ctx, target: input.target });
    return remoteSearch({
      resourceName: input.target,
      resource,
      pattern: input.pattern,
      path: input.path,
      limit: input.limit,
      ...opts,
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
    respect_gitignore: z
      .boolean()
      .default(true)
      .describe('Recursive walks skip paths excluded by .gitignore/.ignore (node_modules, build output). Set false to see everything.'),
  })
  .strict();

export const fileList: ToolDefinition<z.infer<typeof ListInput>> = {
  name: 'file_list',
  toolset: 'file',
  description:
    'List directory contents with type/size/mtime/ctime per entry. Use this to answer questions ' +
    'like "what is the newest file in X?" (sortBy: mtime), "find recently changed configs", ' +
    '"are there empty files in this dir?", "which days between N and M have a daily-note?" — anything ' +
    'that needs a directory enumeration rather than content search. To find files by name pattern ' +
    'in a codebase use `recursive: true` with a `glob` like "**/*.test.ts" — ignored paths ' +
    '(node_modules, build output, per .gitignore) are skipped unless `respect_gitignore: false`. ' +
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
      glob: { type: 'string', description: 'Filter pattern. *, **, ? supported. Without `/` matches basenames, with `/` relative paths.' },
      respect_gitignore: {
        type: 'boolean',
        default: true,
        description: 'Recursive walks skip .gitignore/.ignore\'d paths (node_modules, build output). false = list everything.',
      },
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
        session: ctx.session,
        config: ctx.config,
        recursive: input.recursive,
        sortBy: input.sortBy,
        limit: input.limit,
        respectGitignore: input.respect_gitignore,
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
      respectGitignore: input.respect_gitignore,
      ...(input.glob ? { glob: input.glob } : {}),
    });
  },
};

export function fileTools(): ToolDefinition[] {
  return [fileRead, fileWrite, filePatch, fileSearch, fileList] as ToolDefinition[];
}
