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
import { resolveVisibleResource } from '../resources/visibility.ts';
import type { ToolDefinition } from '../types.ts';
import { localPatch, localRead, localSearch, localWrite } from './local.ts';
import { remotePatch, remoteRead, remoteSearch, remoteWrite } from './remote.ts';

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
  ctx: { agent: string; config: import('../../config/types.ts').Config };
  target: string;
}) {
  const resource = await resolveVisibleResource(args.ctx.agent, args.ctx.config, args.target);
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
    'Read a text file from the local filesystem or a remote resource. Relative paths resolve ' +
    'against the agent\'s workspace dir; absolute paths pass through. Returns content plus ' +
    'line/byte counts. Use offset+limit to page through large files (single read caps at 200k chars). ' +
    'Use this INSTEAD of running `cat`, `head`, or `tail` via exec — file_read paginates safely, ' +
    'enforces the read-blacklist, and never gets caught by shell quoting.',
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

export function fileTools(): ToolDefinition[] {
  return [fileRead, fileWrite, filePatch, fileSearch] as ToolDefinition[];
}
