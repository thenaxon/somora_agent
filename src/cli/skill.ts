// `somora skill <subcommand>` — list / check / add / update / remove.
//
// Operates entirely against the user's skill dir (~/.somora/skills/) plus
// the bundled templates dir (<package>/templates/skills/). Does NOT talk to
// the running server — all checks are filesystem-local. After adding or
// editing, the server picks up changes on the next agent turn (re-read per
// call, see src/skills/load.ts).
//
// Subcommand semantics:
//   list                 print all skills + availability status
//   check <slug>         full validation: frontmatter + body lint + availability
//   add <slug> [opts]    pre-flight lint, write atomically. Refuses overwrite
//                        unless --force.
//   update <slug>        force re-seed a built-in from its bundled template
//   remove <slug>        delete the user copy (built-ins get re-seeded next start)
//
// CLI flag parsing is hand-rolled (matches the rest of src/cli/somora.ts —
// no commander/yargs dep).

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import matter from 'gray-matter';

import { loadConfig } from '../config/loader.ts';
import { loadSomoraEnvFile } from '../server/env-file.ts';
import { loadAvailableSkills, type LoadedSkill } from '../skills/load.ts';
import { lintSkillBody, summarizeFindings } from '../skills/lint.ts';
import {
  BUILTIN_SKILLS_DIR,
  forceUpdateBuiltinSkill,
  listBuiltinSkillSlugs,
} from '../skills/bootstrap.ts';
import { isClawHubUrl, resolveClawHubUrl } from './resolvers/clawhub.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const USER_SKILLS_DIR = join(SOMORA_HOME, 'skills');

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DOWNLOAD_BYTES = 100 * 1024;

const COLOR = process.stdout.isTTY;
const c = {
  green: (s: string) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
};

function usage(): string {
  return `Usage:
  somora skill list [--all] [--available-only]
  somora skill check <slug>
  somora skill add <slug> [--template <name>] [--description <text>]
                          [--from-url <url>] [--from-file <path>]
                          [--force] [--yes]
  somora skill update <slug>          (force re-seed a built-in)
  somora skill remove <slug> [--yes]
`;
}

function parseFlags(args: string[], known: Record<string, 'bool' | 'value'>): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const kind = known[name];
      if (!kind) throw new Error(`unknown flag: ${a}`);
      if (kind === 'bool') {
        flags[name] = true;
      } else {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) {
          throw new Error(`flag --${name} requires a value`);
        }
        flags[name] = v;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ─── list ─────────────────────────────────────────────────────────────

async function cmdList(args: string[]): Promise<number> {
  const { flags } = parseFlags(args, { all: 'bool', 'available-only': 'bool' });
  loadSomoraEnvFile();
  const config = await loadConfig();
  const skills = await loadAvailableSkills(config);

  if (skills.length === 0) {
    process.stdout.write('No skills installed.\n');
    return 0;
  }

  const showAll = flags.all === true;
  const onlyAvail = flags['available-only'] === true;
  const filtered = skills.filter((s) => {
    if (onlyAvail) return s.available;
    if (!showAll && !s.available) return false;
    return true;
  });

  // Default behavior: show available skills only (mirrors what agents see).
  // --all also lists unavailable. --available-only is an alias that explicit-
  // ly excludes unavailable even when --all is mixed in.
  const list = showAll || onlyAvail ? filtered : skills.filter((s) => s.available);

  const maxName = list.reduce((m, s) => Math.max(m, s.name.length), 0);
  for (const s of list) {
    const name = s.name.padEnd(maxName);
    const status = s.available ? c.green('available  ') : c.yellow('unavailable');
    const desc = s.description.length > 80 ? s.description.slice(0, 77) + '...' : s.description;
    process.stdout.write(`${status}  ${c.bold(name)}  ${c.dim(desc)}\n`);
    if (!s.available && s.unavailableReason) {
      process.stdout.write(`${''.padStart(13)}  ${''.padStart(maxName)}  ${c.dim('reason: ' + s.unavailableReason)}\n`);
    }
  }
  return 0;
}

// ─── check ────────────────────────────────────────────────────────────

async function cmdCheck(args: string[]): Promise<number> {
  const slug = args[0];
  if (!slug) {
    process.stderr.write('usage: somora skill check <slug>\n');
    return 2;
  }
  if (!SLUG_RE.test(slug)) {
    process.stderr.write(`invalid slug: ${slug} (must match ${SLUG_RE})\n`);
    return 2;
  }
  loadSomoraEnvFile();
  const config = await loadConfig();
  const skills = await loadAvailableSkills(config);
  const skill = skills.find((s) => s.name === slug);
  if (!skill) {
    // Distinguish "no file on disk" from "file exists but loader rejected".
    // The bare 'not found' message used to hide parse/schema errors that the
    // loader logs as warnings and silently skips (see hans bug 2026-05-11).
    const skillDir = join(USER_SKILLS_DIR, slug);
    const skillMdPath = join(skillDir, 'SKILL.md');
    if (await pathExists(skillMdPath)) {
      process.stderr.write(
        `Skill '${slug}' has a SKILL.md on disk at ${skillMdPath}, ` +
          `but the loader skipped it (frontmatter schema mismatch, name/dir mismatch, ` +
          `or read error). Check server logs for 'skills.frontmatter_invalid' / ` +
          `'skills.name_mismatch' / 'skills.read_failed' entries. ` +
          `Run \`head ${skillMdPath}\` to inspect the file contents.\n`,
      );
      return 1;
    }
    process.stderr.write(`Skill '${slug}' not found in ${USER_SKILLS_DIR}.\n`);
    return 1;
  }
  return printCheckReport(skill);
}

function printCheckReport(skill: LoadedSkill): number {
  const summary = summarizeFindings(skill.lintFindings);
  const ok = skill.available;

  process.stdout.write(`Skill: ${c.bold(skill.name)}\n`);
  process.stdout.write(`  description: ${skill.description}\n`);
  process.stdout.write(`  dir:         ${skill.dir}\n`);

  if (summary.errorCount === 0 && summary.warningCount === 0) {
    process.stdout.write(`  ${c.green('✓')} body lint: 0 errors, 0 warnings\n`);
  } else {
    const sev = summary.errorCount > 0 ? c.red('✗') : c.yellow('!');
    process.stdout.write(`  ${sev} body lint: ${summary.errorCount} errors, ${summary.warningCount} warnings\n`);
    for (const f of skill.lintFindings) {
      const tag = f.severity === 'error' ? c.red('error  ') : c.yellow('warning');
      process.stdout.write(`    L${f.line.toString().padStart(3)} ${tag} ${f.rule}: ${f.message}\n`);
    }
  }

  if (skill.requiresBins.length > 0) {
    process.stdout.write(`  requires.bins:     ${skill.requiresBins.join(', ')}\n`);
  }
  if (skill.requiresConfig.length > 0) {
    process.stdout.write(`  requires.config:   ${skill.requiresConfig.join(', ')}\n`);
  }
  if (skill.requiresEnvVars.length > 0) {
    process.stdout.write(`  requires.env_vars: ${skill.requiresEnvVars.join(', ')}\n`);
  }

  if (ok) {
    process.stdout.write(`${c.green(`Skill '${skill.name}' is healthy.`)}\n`);
    return 0;
  }
  process.stdout.write(`${c.red(`Skill '${skill.name}' is unavailable.`)} ${c.dim('reason: ' + (skill.unavailableReason ?? 'unknown'))}\n`);
  return 1;
}

// ─── add ──────────────────────────────────────────────────────────────

async function cmdAdd(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, {
    template: 'value',
    description: 'value',
    'from-url': 'value',
    'from-file': 'value',
    force: 'bool',
    yes: 'bool',
  });
  const slug = positional[0];
  if (!slug) {
    process.stderr.write('usage: somora skill add <slug> [options]\n');
    return 2;
  }
  if (!SLUG_RE.test(slug) || slug.length > 64) {
    process.stderr.write(`invalid slug: '${slug}' (must match ${SLUG_RE}, ≤64 chars)\n`);
    return 2;
  }
  if (slug.startsWith('_')) {
    process.stderr.write(`invalid slug: '${slug}' (leading underscore is reserved)\n`);
    return 2;
  }

  const userDir = join(USER_SKILLS_DIR, slug);
  const exists = await pathExists(userDir);
  if (exists && !flags.force) {
    process.stderr.write(
      `Skill '${slug}' already exists at ${userDir}. Pass --force to overwrite.\n`,
    );
    return 1;
  }

  // Resolve source: --from-url > --from-file > --template
  let skillMdContent: string;
  let sourceLabel: string;
  let extraFiles: Array<{ relPath: string; content: Buffer }> = [];

  if (flags['from-url']) {
    const url = flags['from-url'] as string;
    if (isClawHubUrl(url)) {
      // ClawHub URLs go through the marketplace resolver: ZIP download,
      // sub-resource extraction, openclaw→somora frontmatter translation.
      // The resolver throws on rate-limit / moderation-block / 404 / etc.
      const resolution = await resolveClawHubUrl(url);
      sourceLabel = resolution.sourceLabel;
      skillMdContent = resolution.skillMd;
      extraFiles = resolution.extraFiles;
      // If the canonical slug differs from the user's requested slug, warn
      // but proceed — the user named it `<slug>` and we honor that.
      if (resolution.canonicalSlug !== slug) {
        process.stderr.write(
          `${c.yellow('Note:')} ClawHub's canonical slug for this skill is '${resolution.canonicalSlug}'; ` +
            `installing under your requested local slug '${slug}'.\n`,
        );
      }
    } else {
      sourceLabel = `URL: ${url}`;
      skillMdContent = await downloadSkillMd(url);
      rejectIfHtml(skillMdContent, sourceLabel);
    }
  } else if (flags['from-file']) {
    const path = resolve(flags['from-file'] as string);
    sourceLabel = `file: ${path}`;
    skillMdContent = await fs.readFile(path, 'utf8');
    rejectIfHtml(skillMdContent, sourceLabel);
  } else {
    const templateName = (flags.template as string | undefined) ?? 'default';
    sourceLabel = `template: ${templateName}`;
    const tpl = await loadTemplate(templateName);
    skillMdContent = substitutePlaceholders(tpl.skillMd, {
      slug,
      description: (flags.description as string | undefined) ?? `TODO: describe '${slug}'`,
      whenToUse: 'TODO: explain when an agent should activate this skill',
      binName: slug,
    });
    extraFiles = tpl.extraFiles.map((e) => ({
      relPath: e.relPath,
      content: Buffer.from(
        substitutePlaceholders(e.content.toString('utf8'), {
          slug,
          description: (flags.description as string | undefined) ?? `TODO: describe '${slug}'`,
          whenToUse: 'TODO: explain when an agent should activate this skill',
          binName: slug,
        }),
        'utf8',
      ),
    }));
  }

  // Pre-flight: parse frontmatter, validate name, run body lint.
  const parsed = matter(skillMdContent);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  if (typeof fm.name === 'string' && fm.name !== slug) {
    if (flags['from-url'] || flags['from-file']) {
      process.stderr.write(
        `Frontmatter name '${fm.name}' does not match slug '${slug}'. ` +
          `Rename the slug, or fix the source SKILL.md.\n`,
      );
      return 1;
    }
    // template-driven path: substitution should have set this, but guard
    fm.name = slug;
  } else if (!fm.name) {
    fm.name = slug;
  }
  // Re-stringify with corrected name if we touched it.
  if (parsed.data?.name !== slug) {
    skillMdContent = matter.stringify(parsed.content, { ...parsed.data, name: slug });
  }

  const findings = lintSkillBody(parsed.content.trim());
  const lintSummary = summarizeFindings(findings);

  if (lintSummary.errorCount > 0) {
    process.stderr.write(`${c.red('Lint failed:')} ${lintSummary.errorCount} errors, ${lintSummary.warningCount} warnings\n`);
    for (const f of findings) {
      const tag = f.severity === 'error' ? c.red('error  ') : c.yellow('warning');
      process.stderr.write(`  L${f.line.toString().padStart(3)} ${tag} ${f.rule}: ${f.message}\n`);
    }
    process.stderr.write(
      `\nRefusing to write '${slug}'. Fix the source and retry. (source: ${sourceLabel})\n`,
    );
    return 1;
  }

  if (lintSummary.warningCount > 0 && !flags.yes) {
    process.stderr.write(`${c.yellow('Lint warnings:')} ${lintSummary.warningCount}\n`);
    for (const f of findings) {
      process.stderr.write(`  L${f.line.toString().padStart(3)} ${c.yellow('warning')} ${f.rule}: ${f.message}\n`);
    }
    process.stderr.write(`\nPass --yes to write anyway.\n`);
    return 1;
  }

  // Atomic write: stage to temp dir, rename into place. We also need to
  // remember the *prior* userDir contents in case the post-write loader
  // verification fails — then we restore the original (or remove the new
  // dir if there was no prior).
  await fs.mkdir(USER_SKILLS_DIR, { recursive: true });
  const stagePath = `${userDir}.add-${process.pid}-${Date.now()}`;
  await fs.mkdir(stagePath, { recursive: true });
  await fs.writeFile(join(stagePath, 'SKILL.md'), skillMdContent, 'utf8');
  for (const e of extraFiles) {
    const dst = join(stagePath, e.relPath);
    await fs.mkdir(join(dst, '..'), { recursive: true });
    await fs.writeFile(dst, e.content);
  }
  const backupPath = exists ? `${userDir}.add-backup-${process.pid}-${Date.now()}` : null;
  if (exists && backupPath) {
    await fs.rename(userDir, backupPath);
  }
  await fs.rename(stagePath, userDir);

  // Post-write verification: success means the loader can actually read
  // the skill, not just that bytes landed on disk. If lint passed but
  // the loader still drops it (frontmatter schema mismatch, name/dir
  // collision, fs error etc.), roll back rather than report a false
  // success. See feedback 2026-05-11_skill-from-url-html-success.md.
  try {
    loadSomoraEnvFile();
    const config = await loadConfig();
    const loaded = await loadAvailableSkills(config);
    const seen = loaded.find((s) => s.name === slug);
    if (!seen) {
      throw new Error(
        `loader did not return '${slug}' after write — frontmatter or schema mismatch. ` +
          `Inspect ${join(userDir, 'SKILL.md')} for issues.`,
      );
    }
  } catch (err) {
    // Roll back: remove the freshly-written dir, restore the backup if any.
    await fs.rm(userDir, { recursive: true, force: true }).catch(() => {});
    if (backupPath) {
      await fs.rename(backupPath, userDir).catch(() => {});
    }
    process.stderr.write(
      `${c.red('Post-write verification failed:')} ${(err as Error).message}\n`,
    );
    process.stderr.write(`No changes left on disk. (source: ${sourceLabel})\n`);
    return 1;
  }
  if (backupPath) {
    await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {});
  }

  process.stdout.write(`${c.green('✓')} Skill '${slug}' added at ${userDir}\n`);
  process.stdout.write(`  source: ${sourceLabel}\n`);
  if (extraFiles.length > 0) {
    process.stdout.write(`  extras: ${extraFiles.map((e) => e.relPath).join(', ')}\n`);
  }
  process.stdout.write(`\nThe running server picks up new skills on the next agent turn.\n`);
  return 0;
}

/** Reject the source if it looks like an HTML document instead of a SKILL.md.
 *  Catches the common case where --from-url points at a marketplace landing
 *  page (e.g. ClawHub) instead of the raw markdown file. The lint layer also
 *  carries a body-rule for the same pattern, but failing early here yields a
 *  clearer message tied to the source URL/file. */
function rejectIfHtml(content: string, sourceLabel: string): void {
  const head = content.slice(0, 4000).toLowerCase();
  if (/<!doctype\s+html/.test(head) || /<html[\s>]/.test(head)) {
    throw new Error(
      `${sourceLabel} returned an HTML document, not a SKILL.md. ` +
        `If this is a marketplace landing page (e.g. ClawHub), use the raw markdown URL ` +
        `or download the SKILL.md and reinstall via --from-file.`,
    );
  }
}

async function downloadSkillMd(url: string): Promise<string> {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`URL must be http(s): ${url}`);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (
      ct &&
      !ct.includes('text/') &&
      !ct.includes('application/octet-stream') &&
      !ct.includes('markdown')
    ) {
      throw new Error(`unexpected content-type '${ct}' (expected text/markdown or text/plain)`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`response too large: ${buf.byteLength} bytes (max ${MAX_DOWNLOAD_BYTES})`);
    }
    return buf.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

async function loadTemplate(name: string): Promise<{
  skillMd: string;
  extraFiles: Array<{ relPath: string; content: Buffer }>;
}> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid template name: ${name}`);
  }
  const dir = join(BUILTIN_SKILLS_DIR, '_templates', name);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const available = await listTemplateNames();
      throw new Error(
        `template '${name}' not found. Available: ${available.join(', ') || '(none)'}`,
      );
    }
    throw err;
  }
  let skillMd: string | null = null;
  const extraFiles: Array<{ relPath: string; content: Buffer }> = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const buf = await fs.readFile(join(dir, e.name));
    if (e.name === 'SKILL.md') {
      skillMd = buf.toString('utf8');
    } else {
      extraFiles.push({ relPath: e.name, content: buf });
    }
  }
  if (!skillMd) {
    throw new Error(`template '${name}' has no SKILL.md`);
  }
  return { skillMd, extraFiles };
}

async function listTemplateNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(join(BUILTIN_SKILLS_DIR, '_templates'), {
      withFileTypes: true,
    });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function substitutePlaceholders(
  text: string,
  vars: { slug: string; description: string; whenToUse: string; binName: string },
): string {
  // YAML-safe escaping: descriptions/when_to_use sit inside double-quoted
  // YAML strings (see templates/skills/_templates/*/SKILL.md), so embedded
  // backslashes and double-quotes need escaping. Colons and other chars are
  // fine inside double-quoted YAML scalars.
  const yamlEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return text
    .replace(/__SLUG__/g, vars.slug)
    .replace(/__DESCRIPTION__/g, yamlEscape(vars.description))
    .replace(/__WHEN_TO_USE__/g, yamlEscape(vars.whenToUse))
    .replace(/__BIN_NAME__/g, vars.binName);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── update ───────────────────────────────────────────────────────────

async function cmdUpdate(args: string[]): Promise<number> {
  const slug = args[0];
  if (!slug) {
    process.stderr.write('usage: somora skill update <slug>\n');
    return 2;
  }
  const builtins = await listBuiltinSkillSlugs();
  if (!builtins.includes(slug)) {
    process.stderr.write(
      `'${slug}' is not a built-in skill (available built-ins: ${builtins.join(', ') || '(none)'})\n`,
    );
    return 1;
  }
  try {
    await forceUpdateBuiltinSkill(slug);
  } catch (err) {
    process.stderr.write(`failed to update '${slug}': ${(err as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`${c.green('✓')} Built-in skill '${slug}' re-seeded from bundled template.\n`);
  return 0;
}

// ─── remove ───────────────────────────────────────────────────────────

async function cmdRemove(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, { yes: 'bool' });
  const slug = positional[0];
  if (!slug) {
    process.stderr.write('usage: somora skill remove <slug> [--yes]\n');
    return 2;
  }
  if (!SLUG_RE.test(slug)) {
    process.stderr.write(`invalid slug: ${slug}\n`);
    return 2;
  }
  const userDir = join(USER_SKILLS_DIR, slug);
  if (!(await pathExists(userDir))) {
    process.stderr.write(`Skill '${slug}' not found at ${userDir}.\n`);
    return 1;
  }
  if (!flags.yes) {
    process.stderr.write(`Will delete ${userDir}. Pass --yes to confirm.\n`);
    return 1;
  }
  await fs.rm(userDir, { recursive: true, force: true });
  process.stdout.write(`${c.green('✓')} Removed ${userDir}\n`);
  const builtins = await listBuiltinSkillSlugs();
  if (builtins.includes(slug)) {
    process.stdout.write(
      `${c.dim('Note: ')}'${slug}' is a built-in skill — it will be re-seeded the next time somora starts. ` +
        `Delete or edit ~/.somora/.skill-seed-state.json if you want to suppress that.\n`,
    );
  }
  return 0;
}

// ─── entry ────────────────────────────────────────────────────────────

export async function runSkillCli(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  try {
    switch (sub) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(usage());
        return sub ? 0 : 1;
      case 'list':
        return await cmdList(rest);
      case 'check':
        return await cmdCheck(rest);
      case 'add':
        return await cmdAdd(rest);
      case 'update':
        return await cmdUpdate(rest);
      case 'remove':
        return await cmdRemove(rest);
      default:
        process.stderr.write(`unknown subcommand: somora skill ${sub}\n${usage()}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`somora skill ${sub ?? ''}: ${(err as Error).message}\n`);
    return 1;
  }
}
