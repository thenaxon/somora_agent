#!/usr/bin/env -S npx tsx
// v2.2 one-time migration — convert all existing memory stubs to either
// fresh memory files (when Recent observations exist) or delete them
// (when pure pointer-stubs).
//
// After this script: no memory file has `promoted_to` frontmatter.
// The v2.2+ codebase drops stub-detection entirely.
//
// Idempotent: running again finds 0 stubs and exits cleanly.
//
// Usage: tsx scripts/v2.2-destub-memories.ts [--dry-run]

import { readdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import matter from 'gray-matter';
import yaml from 'js-yaml';

const STUB_HEADER = '## Recent observations (will be promoted next dream-B)';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const dryRun = process.argv.includes('--dry-run');

interface Outcome {
  agent: string;
  slug: string;
  path: string;
  action: 'unlink' | 'rewrite-fresh' | 'skip-not-stub';
  observations?: number;
}

function isStubFrontmatter(fm: Record<string, unknown>): boolean {
  return typeof fm.promoted_to === 'string' && (typeof fm.promoted_at === 'string' || fm.promoted_at instanceof Date);
}

function extractObservations(stubBody: string): string[] {
  const headerIdx = stubBody.indexOf(STUB_HEADER);
  if (headerIdx === -1) return [];
  const after = stubBody.slice(headerIdx + STUB_HEADER.length);
  const lines = after.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('-')) break;
    out.push(t);
  }
  return out;
}

async function listAgents(): Promise<string[]> {
  const dir = join(SOMORA_HOME, 'agents');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function processFile(agent: string, path: string): Promise<Outcome | null> {
  const slug = path.split('/').pop()!.replace(/\.md$/, '');
  const raw = await readFile(path, 'utf8');
  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  if (!isStubFrontmatter(fm)) {
    return { agent, slug, path, action: 'skip-not-stub' };
  }
  const observations = extractObservations(parsed.content);
  if (observations.length === 0) {
    if (!dryRun) await unlink(path);
    return { agent, slug, path, action: 'unlink' };
  }
  // Rewrite as fresh memory: drop promoted_to/promoted_at, keep slug/created/updated
  // Body becomes the observations as plain bullets (drop the dream-B-specific header).
  const today = new Date().toISOString().slice(0, 10);
  const newFm = {
    slug: typeof fm.slug === 'string' ? fm.slug : slug,
    created: typeof fm.created === 'string' ? fm.created : today,
    updated: today,
  };
  const yamlBlock = yaml.dump(newFm).trimEnd();
  const body = [
    `# ${slug}`,
    '',
    '## Recent observations (carried over from v1 stub)',
    '',
    ...observations,
    '',
  ].join('\n');
  const newContent = `---\n${yamlBlock}\n---\n\n${body}`;
  if (!dryRun) {
    const st = await stat(path);
    await writeFile(path, newContent, 'utf8');
    // Preserve mtime would be nice but not required — Deep treats this as fresh anyway.
    void st;
  }
  return { agent, slug, path, action: 'rewrite-fresh', observations: observations.length };
}

async function main(): Promise<void> {
  const agents = await listAgents();
  const all: Outcome[] = [];
  for (const agent of agents) {
    const memDir = join(SOMORA_HOME, 'agents', agent, 'memory');
    let entries;
    try {
      entries = await readdir(memDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      if (e.name.startsWith('.')) continue;
      const path = join(memDir, e.name);
      try {
        const outcome = await processFile(agent, path);
        if (outcome) all.push(outcome);
      } catch (err) {
        console.error(`  ERROR ${agent}/${e.name}: ${(err as Error).message}`);
      }
    }
  }

  const summary = {
    'unlink': all.filter((o) => o.action === 'unlink').length,
    'rewrite-fresh': all.filter((o) => o.action === 'rewrite-fresh').length,
    'skip-not-stub': all.filter((o) => o.action === 'skip-not-stub').length,
  };

  console.log(dryRun ? '\n=== DRY RUN — no changes written ===\n' : '\n=== MIGRATION DONE ===\n');
  console.log(`  files visited: ${all.length}`);
  console.log(`  unlink (pure pointer-stub):       ${summary.unlink}`);
  console.log(`  rewrite-fresh (had observations): ${summary['rewrite-fresh']}`);
  console.log(`  skip (already fresh):              ${summary['skip-not-stub']}`);

  if (summary['rewrite-fresh'] > 0) {
    console.log('\n  Rewrites (will be re-evaluated on next Deep run):');
    for (const o of all.filter((o) => o.action === 'rewrite-fresh')) {
      console.log(`    ${o.agent}/${o.slug}  (${o.observations} obs)`);
    }
  }
  if (dryRun) console.log('\n  Run without --dry-run to actually apply.');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
