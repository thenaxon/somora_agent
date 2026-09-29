// Where migration plans live: ~/.somora/wiki-migration/<id>/plan.json + plan.md

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { MigrationPlan } from './analyze.ts';
import { renderPlan } from './analyze.ts';
import { renderRefinedPlan, type RefinedPlan } from './refine.ts';
import type { WikiLanguage } from '../language.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
export const MIGRATION_ROOT = join(SOMORA_HOME, 'wiki-migration');

export function planId(now = new Date()): string {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

export async function writePlan(plan: MigrationPlan, id = planId()): Promise<{ id: string; dir: string; markdown: string }> {
  const dir = join(MIGRATION_ROOT, id);
  await mkdir(dir, { recursive: true });
  const markdown = join(dir, 'plan.md');
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  await writeFile(markdown, renderPlan(plan), 'utf8');
  return { id, dir, markdown };
}

export async function readPlan(id: string): Promise<MigrationPlan | null> {
  try {
    return JSON.parse(await readFile(join(MIGRATION_ROOT, id, 'plan.json'), 'utf8')) as MigrationPlan;
  } catch {
    return null;
  }
}

export async function writeRefinedPlan(id: string, refined: RefinedPlan, language: WikiLanguage): Promise<{ markdown: string }> {
  const dir = join(MIGRATION_ROOT, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'refined.json'), JSON.stringify(refined, null, 2), 'utf8');
  const markdown = join(dir, 'refined.md');
  await writeFile(markdown, renderRefinedPlan(refined, language), 'utf8');
  return { markdown };
}

export async function readRefinedPlan(id: string): Promise<RefinedPlan | null> {
  try {
    return JSON.parse(await readFile(join(MIGRATION_ROOT, id, 'refined.json'), 'utf8')) as RefinedPlan;
  } catch {
    return null;
  }
}
