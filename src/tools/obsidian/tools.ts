// obsidian_* tools — typed Vault operations with readOnlyPaths
// enforcement and wikilink-preserving move. Pure-TS implementation
// (no obsidian-cli dependency); inspired by obsidian-cli's API surface
// but reimplemented so somora stays self-contained.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import type { ToolDefinition } from '../types.ts';
import {
  assertInsideVault,
  isReadOnly,
  listMarkdownFiles,
  resolveVault,
  resolveVaultRelative,
  vaultRelative,
} from './vault.ts';

// ─────────────────────────────────────────────────────────────────────
// obsidian_write — create / overwrite / append a vault markdown file
// ─────────────────────────────────────────────────────────────────────

const WriteInput = z
  .object({
    path: z
      .string()
      .min(1)
      .describe('Vault-relative path to the .md file (e.g. "Projekte/Notes/today.md").'),
    content: z.string().describe('Markdown body — without YAML frontmatter (use the `frontmatter` field for that).'),
    mode: z.enum(['create', 'overwrite', 'append']).default('create'),
    frontmatter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Optional YAML frontmatter object. For "create"/"overwrite" replaces existing frontmatter; ignored for "append".'),
  })
  .strict();

export const obsidianWrite: ToolDefinition<z.infer<typeof WriteInput>> = {
  name: 'obsidian_write',
  toolset: 'obsidian',
  description:
    'Write a Markdown file into the user\'s Obsidian vault. ' +
    'Use this for vault content; for somora\'s own private notes use `memory_write` instead. ' +
    'Modes: `create` (default — refuses if the file exists), `overwrite` (replaces fully), ' +
    '`append` (adds to existing, creates if missing). The path is vault-relative and ' +
    'parent folders are auto-created. Optional `frontmatter` is a YAML object that gets ' +
    'serialised at the top of the file. Paths under the agent\'s configured ' +
    '`obsidian.readOnlyPaths` are refused.',
  inputSchema: WriteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Vault-relative path to the .md file.' },
      content: { type: 'string', description: 'Markdown body (no YAML frontmatter; use the `frontmatter` field).' },
      mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: 'Default: create.' },
      frontmatter: {
        type: 'object',
        description: 'Optional YAML frontmatter as JSON object.',
        additionalProperties: true,
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  available: async ({ agent }) => Boolean(await resolveVault(agent)),
  async handler(input, ctx) {
    const vault = await resolveVault(ctx.agent);
    if (!vault) throw new Error(`obsidian_write: agent '${ctx.agent}' has no vault configured`);

    const ro = isReadOnly(input.path, vault.readOnlyPaths);
    if (ro) throw new Error(`obsidian_write: '${input.path}' is under read-only path '${ro}'`);

    const targetAbs = resolveVaultRelative(vault.vaultPath, input.path);
    const finalPath = targetAbs.toLowerCase().endsWith('.md') ? targetAbs : `${targetAbs}.md`;
    await mkdir(dirname(finalPath), { recursive: true });
    await assertInsideVault(vault.vaultPath, finalPath);

    const exists = await fileExists(finalPath);
    if (input.mode === 'create' && exists) {
      throw new Error(`obsidian_write: '${input.path}' already exists; use mode='overwrite' or 'append'`);
    }
    if (input.mode === 'append' && !exists) {
      // Treat append-of-missing-file as create — no frontmatter merge.
      await writeFile(finalPath, input.content, 'utf8');
      return { ok: true, mode: 'append-as-create', path: vaultRelative(vault.vaultPath, finalPath) };
    }

    let body: string;
    if (input.mode === 'append') {
      const existing = await readFile(finalPath, 'utf8');
      const sep = existing.endsWith('\n') ? '' : '\n';
      body = existing + sep + input.content;
    } else {
      // create | overwrite: serialise frontmatter (if given) + body.
      body = input.frontmatter
        ? matter.stringify(input.content, input.frontmatter)
        : input.content;
    }

    await writeFile(finalPath, body, 'utf8');
    logger.info({
      msg: 'tool.obsidian_write',
      agent: ctx.agent,
      path: vaultRelative(vault.vaultPath, finalPath),
      mode: input.mode,
      bytes: body.length,
    });
    return {
      ok: true,
      mode: input.mode,
      path: vaultRelative(vault.vaultPath, finalPath),
      bytes: body.length,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// obsidian_move — rename / relocate a note, preserving [[wikilinks]]
// ─────────────────────────────────────────────────────────────────────
//
// Killer feature: when you move A.md → B.md, every [[A]] / [[A|x]] /
// [[A#h]] / [[A#h|x]] / [[folder/A]] reference in the vault is
// rewritten to point at the new path/name. obsidian-cli does this; mv
// does not. Markdown-style links ([text](path.md)) are NOT rewritten —
// most Obsidian users use wikilinks; covering markdown links would
// double the regex complexity for marginal gain. Documented in the
// description.

const MoveInput = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

export const obsidianMove: ToolDefinition<z.infer<typeof MoveInput>> = {
  name: 'obsidian_move',
  toolset: 'obsidian',
  description:
    'Rename or relocate a Markdown file inside the Obsidian vault. ' +
    'CRITICAL: this is the only way to move vault notes that preserves [[wikilinks]] — ' +
    'every reference to the old basename or relative path in the vault is rewritten. ' +
    'Both `from` and `to` are vault-relative paths; .md extension is added automatically. ' +
    'Refuses if `from` doesn\'t exist, `to` already exists, or either touches a ' +
    '`obsidian.readOnlyPaths` entry. Markdown-style links `[text](path.md)` are NOT ' +
    'rewritten — only Obsidian-style `[[wikilinks]]`.',
  inputSchema: MoveInput,
  jsonSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path (vault-relative).' },
      to: { type: 'string', description: 'Destination path (vault-relative).' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  available: async ({ agent }) => Boolean(await resolveVault(agent)),
  async handler(input, ctx) {
    const vault = await resolveVault(ctx.agent);
    if (!vault) throw new Error(`obsidian_move: agent '${ctx.agent}' has no vault configured`);

    const fromRo = isReadOnly(input.from, vault.readOnlyPaths);
    if (fromRo) throw new Error(`obsidian_move: source '${input.from}' is under read-only path '${fromRo}'`);
    const toRo = isReadOnly(input.to, vault.readOnlyPaths);
    if (toRo) throw new Error(`obsidian_move: destination '${input.to}' is under read-only path '${toRo}'`);

    const fromAbs = withMdExt(resolveVaultRelative(vault.vaultPath, input.from));
    const toAbs = withMdExt(resolveVaultRelative(vault.vaultPath, input.to));
    await assertInsideVault(vault.vaultPath, fromAbs);
    await mkdir(dirname(toAbs), { recursive: true });
    await assertInsideVault(vault.vaultPath, toAbs);

    if (!(await fileExists(fromAbs))) {
      throw new Error(`obsidian_move: source '${input.from}' does not exist`);
    }
    if (await fileExists(toAbs)) {
      throw new Error(`obsidian_move: destination '${input.to}' already exists`);
    }

    // Wikilink rewrite needs the relative paths *before* and *after*.
    const oldRel = vaultRelative(vault.vaultPath, fromAbs);
    const newRel = vaultRelative(vault.vaultPath, toAbs);
    const oldBase = basename(oldRel, '.md');
    const newBase = basename(newRel, '.md');
    const oldRelNoExt = oldRel.replace(/\.md$/i, '');
    const newRelNoExt = newRel.replace(/\.md$/i, '');

    // Check basename uniqueness — if multiple files share basename, we
    // can't safely rewrite [[basename]] references because they're
    // ambiguous. In that case we only rewrite explicit-path references.
    const allFiles = await listMarkdownFiles(vault.vaultPath);
    const sameBasenameOthers = allFiles.filter(
      (f) => basename(f, '.md') === oldBase && f !== oldRel,
    );
    const basenameUnique = sameBasenameOthers.length === 0;

    // Move first — if the rename fails we don't want to have rewritten
    // links pointing at a not-yet-moved file.
    await rename(fromAbs, toAbs);

    let updatedFiles = 0;
    let skippedAmbiguous = sameBasenameOthers.length > 0 ? 1 : 0;
    for (const rel of allFiles) {
      if (rel === oldRel || rel === newRel) continue;
      const abs = join(vault.vaultPath, rel);
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const before = content;
      content = rewriteWikilinks(content, {
        oldBase,
        newBase,
        oldRelNoExt,
        newRelNoExt,
        rewriteByBasename: basenameUnique,
      });
      if (content !== before) {
        await writeFile(abs, content, 'utf8');
        updatedFiles++;
      }
    }

    logger.info({
      msg: 'tool.obsidian_move',
      agent: ctx.agent,
      from: oldRel,
      to: newRel,
      wikilinks_updated_in_files: updatedFiles,
      basename_unique: basenameUnique,
    });

    return {
      ok: true,
      from: oldRel,
      to: newRel,
      wikilinksUpdatedInFiles: updatedFiles,
      ...(skippedAmbiguous > 0
        ? {
            warning:
              `basename '${oldBase}' is not unique in the vault — only explicit-path wikilinks were rewritten. ` +
              `Bare [[${oldBase}]] references to other notes were left untouched.`,
          }
        : {}),
    };
  },
};

interface RewriteOpts {
  oldBase: string;
  newBase: string;
  oldRelNoExt: string;
  newRelNoExt: string;
  rewriteByBasename: boolean;
}

/**
 * Rewrite Obsidian-style `[[…]]` references for a single move.
 * Patterns handled (each may have an optional |display and/or #heading):
 *   [[oldBase]]              → [[newBase]]                (only if basename unique)
 *   [[oldRelative]]          → [[newRelative]]            (always)
 * `oldRelative` is matched in both forward-slash and case-insensitive forms.
 */
function rewriteWikilinks(content: string, opts: RewriteOpts): string {
  const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Pattern: [[ <target> ( #heading )? ( |display )? ]]
  // We match the target greedily up to # | or ]]
  const replaceTarget = (text: string, oldTarget: string, newTarget: string): string => {
    const escTarget = escapeForRegex(oldTarget);
    const re = new RegExp(`\\[\\[${escTarget}((?:#[^\\]|]*)?)((?:\\|[^\\]]*)?)\\]\\]`, 'gi');
    return text.replace(re, `[[${newTarget}$1$2]]`);
  };

  let out = content;
  // 1. Explicit-path forms (always safe).
  out = replaceTarget(out, opts.oldRelNoExt, opts.newRelNoExt);
  // 2. Bare basename — only if no other note in the vault has the same basename.
  if (opts.rewriteByBasename && opts.oldBase !== opts.oldRelNoExt) {
    // Don't double-rewrite if the path-form already touched it (it shouldn't,
    // because path form has slashes and basename doesn't).
    out = replaceTarget(out, opts.oldBase, opts.newBase);
  } else if (opts.rewriteByBasename) {
    // basename === relpath (file was at vault root)
    out = replaceTarget(out, opts.oldBase, opts.newBase);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// obsidian_delete — soft-delete by moving into <vault>/.trash/
// ─────────────────────────────────────────────────────────────────────

const DeleteInput = z
  .object({
    path: z.string().min(1),
  })
  .strict();

export const obsidianDelete: ToolDefinition<z.infer<typeof DeleteInput>> = {
  name: 'obsidian_delete',
  toolset: 'obsidian',
  description:
    'Soft-delete a Markdown file from the Obsidian vault. The file is MOVED into ' +
    '`<vault>/.trash/<timestamp>-<original-path>` rather than hard-deleted, so the user ' +
    'can recover it. Refuses if the path is under `obsidian.readOnlyPaths` or doesn\'t ' +
    'exist. Note: wikilinks pointing at the deleted note are NOT rewritten — they\'ll ' +
    'become broken until the user resolves them.',
  inputSchema: DeleteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Vault-relative path to the .md file to delete.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  available: async ({ agent }) => Boolean(await resolveVault(agent)),
  async handler(input, ctx) {
    const vault = await resolveVault(ctx.agent);
    if (!vault) throw new Error(`obsidian_delete: agent '${ctx.agent}' has no vault configured`);

    const ro = isReadOnly(input.path, vault.readOnlyPaths);
    if (ro) throw new Error(`obsidian_delete: '${input.path}' is under read-only path '${ro}'`);

    const sourceAbs = withMdExt(resolveVaultRelative(vault.vaultPath, input.path));
    await assertInsideVault(vault.vaultPath, sourceAbs);

    if (!(await fileExists(sourceAbs))) {
      throw new Error(`obsidian_delete: '${input.path}' does not exist`);
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rel = vaultRelative(vault.vaultPath, sourceAbs);
    const trashRel = `.trash/${ts}-${rel.replace(/[/\\]/g, '__')}`;
    const trashAbs = join(vault.vaultPath, trashRel);
    await mkdir(dirname(trashAbs), { recursive: true });
    await rename(sourceAbs, trashAbs);

    logger.info({
      msg: 'tool.obsidian_delete',
      agent: ctx.agent,
      path: rel,
      trashPath: trashRel,
    });

    return {
      ok: true,
      path: rel,
      trashPath: trashRel,
      hint: 'File moved to .trash/. Restore by moving it back manually.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function withMdExt(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p : `${p}.md`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function obsidianTools(): ToolDefinition[] {
  return [obsidianWrite, obsidianMove, obsidianDelete] as ToolDefinition[];
}
