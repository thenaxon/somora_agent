// Persona loader: reads AGENTS.md / SOUL.md / USER.md per agent and assembles
// a single system prompt. Layout under ~/.somora/agents/<name>/:
//
//   AGENTS.md   ← required. operational rules. frontmatter holds metadata.
//   SOUL.md     ← optional. personality / voice.
//   USER.md     ← optional. context about the human.
//
// Files are re-read on every loadPersona() call so editing them takes effect
// on the next turn — no server restart needed.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const AGENTS_DIR = join(SOMORA_HOME, 'agents');

const VALID_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

const FrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    model: z.string().optional(),
    fallback: z.string().optional(),
  })
  .passthrough();

type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface AgentInfo {
  name: string;
  description: string;
}

export interface Persona {
  name: string;
  description: string;
  model: string | undefined;
  fallback: string | undefined;
  systemPrompt: string;
}

interface ParsedMd {
  data: Frontmatter;
  content: string;
}

async function readMd(path: string): Promise<ParsedMd | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = matter(raw);
  const data = FrontmatterSchema.parse(parsed.data ?? {});
  return { data, content: parsed.content.trim() };
}

export async function listAgents(): Promise<AgentInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(AGENTS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: AgentInfo[] = [];
  for (const entry of entries) {
    if (!VALID_NAME.test(entry)) continue;
    const dir = join(AGENTS_DIR, entry);
    let s;
    try {
      s = await stat(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const agentMd = await readMd(join(dir, 'AGENTS.md'));
    if (!agentMd) continue;
    out.push({ name: entry, description: agentMd.data.description ?? '' });
  }
  return out;
}

export async function loadPersona(name: string): Promise<Persona | null> {
  if (!VALID_NAME.test(name)) return null;
  const dir = join(AGENTS_DIR, name);
  const agentMd = await readMd(join(dir, 'AGENTS.md'));
  if (!agentMd) return null;
  const soulMd = await readMd(join(dir, 'SOUL.md'));
  const userMd = await readMd(join(dir, 'USER.md'));

  const sections: string[] = [];
  if (soulMd?.content) sections.push(soulMd.content);
  if (agentMd.content) sections.push(`# Verhaltensregeln\n\n${agentMd.content}`);
  if (userMd?.content) sections.push(`# Über den User\n\n${userMd.content}`);

  return {
    name,
    description: agentMd.data.description ?? '',
    model: agentMd.data.model,
    fallback: agentMd.data.fallback,
    systemPrompt: sections.join('\n\n---\n\n'),
  };
}

const SAMPLE_AGENTS_MD = `---
name: hans
description: Freundlicher persönlicher Assistent
model: anthropic/claude-opus-4-7
---

- Antworte knapp und klar.
- Sag ehrlich, wenn du etwas nicht weißt — keine Halluzinationen.
- Spiele keine Rollen, du bist Hans.
- Wenn der User nach deinen Tools fragt: aktuell hast du keine externen Tools.
`;

const SAMPLE_SOUL_MD = `# Wer ich bin

Ich bin Hans, ein freundlicher persönlicher Assistent.

Ich rede locker und auf Deutsch, mit etwas Humor, aber ohne Aufgesetztheit.
Ich bin pragmatisch und halte mich an Fakten.
`;

const SAMPLE_USER_MD = `# Über den User

Der User heißt Rene.

(Diese Datei ist ein Platzhalter — fülle sie mit dem Kontext, den der Agent
über dich wissen soll: Rolle, Vorlieben, Zeitzone, Projekte, Sprache, …)
`;

export async function ensureDefaultAgent(): Promise<void> {
  const existing = await listAgents();
  if (existing.length > 0) return;
  const dir = join(AGENTS_DIR, 'hans');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), SAMPLE_AGENTS_MD, 'utf8');
  await writeFile(join(dir, 'SOUL.md'), SAMPLE_SOUL_MD, 'utf8');
  await writeFile(join(dir, 'USER.md'), SAMPLE_USER_MD, 'utf8');
}
