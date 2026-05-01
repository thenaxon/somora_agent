// Persona loader: reads AGENTS.md / SOUL.md / USER.md per agent and assembles
// a single system prompt. Layout under ~/.somora/agents/<name>/:
//
//   AGENTS.md   ← required. behavioral material. frontmatter: identity only
//                 (name, description, icon). Eligible for agent self-edit later.
//   SOUL.md     ← optional. personality / voice.
//   USER.md     ← optional. context about the human.
//   agent.yaml  ← optional. operator-config: model, fallback, (later) tool
//                 allow/deny lists, sampling overrides. Not for agent self-edit.
//
// Files are re-read on every loadPersona() call so editing them takes effect
// on the next turn — no server restart needed.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import { logger } from '../server/logger.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const AGENTS_DIR = join(SOMORA_HOME, 'agents');

const VALID_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

const FrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
  })
  .passthrough();

const DreamConfigSchema = z.object({
  /** Master toggle. When false, Dream-Mode never runs for this agent. */
  enabled: z.boolean(),
  /**
   * Worker model for extraction (alias or `provider/modelId`). Required
   * when enabled — there's intentionally no fallback to the agent's
   * primary, so a dream never silently runs on an expensive model.
   */
  model: z.string().min(1),
  /**
   * Idle minutes before the auto-dream-trigger fires. Reset on every
   * chat.send to this agent. Default 30.
   */
  idleMinutes: z.number().positive().default(30),
  /**
   * Approximate tokens per LLM extraction chunk. Smaller = more frequent
   * pause-points, more LLM round-trip overhead. Larger = better LLM
   * efficiency, larger abort cost when paused. Default 50000.
   */
  chunkTokens: z.number().int().positive().default(50_000),
  /**
   * Per-chunk LLM-call timeout. A single chunk that exceeds this is
   * marked as failed, the dream continues with the next chunk. Default
   * 120000ms (2 minutes) — fits slow local models.
   */
  chunkTimeoutMs: z.number().int().positive().default(120_000),
});

const AgentYamlSchema = z
  .object({
    model: z.string().optional(),
    fallback: z.string().optional(),
    dream: DreamConfigSchema.optional(),
  })
  .passthrough();

export type DreamConfig = z.infer<typeof DreamConfigSchema>;

type Frontmatter = z.infer<typeof FrontmatterSchema>;
type AgentYaml = z.infer<typeof AgentYamlSchema>;

export interface AgentInfo {
  name: string;
  description: string;
  icon: string | undefined;
}

export interface Persona {
  name: string;
  description: string;
  icon: string | undefined;
  model: string | undefined;
  fallback: string | undefined;
  dream: DreamConfig | undefined;
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
  // gray-matter throws on malformed YAML frontmatter. We don't want a single
  // misplaced colon to make an agent unloadable — log and degrade to plain
  // body, no metadata.
  try {
    const parsed = matter(raw);
    const data = FrontmatterSchema.parse(parsed.data ?? {});
    return { data, content: parsed.content.trim() };
  } catch (err) {
    logger.warn({
      msg: 'persona.frontmatter_parse_failed',
      path,
      err: (err as Error).message,
    });
    return { data: {}, content: raw.trim() };
  }
}

async function readAgentYaml(path: string): Promise<AgentYaml> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const doc = parseYaml(raw) ?? {};
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      logger.warn({ msg: 'persona.agent_yaml_not_object', path });
      return {};
    }
    return AgentYamlSchema.parse(doc);
  } catch (err) {
    logger.warn({
      msg: 'persona.agent_yaml_parse_failed',
      path,
      err: (err as Error).message,
    });
    return {};
  }
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
    out.push({
      name: entry,
      description: agentMd.data.description ?? '',
      icon: agentMd.data.icon,
    });
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
  const agentYaml = await readAgentYaml(join(dir, 'agent.yaml'));

  const sections: string[] = [];
  if (soulMd?.content) sections.push(soulMd.content);
  if (agentMd.content) sections.push(`# Verhaltensregeln\n\n${agentMd.content}`);
  if (userMd?.content) sections.push(`# Über den User\n\n${userMd.content}`);

  return {
    name,
    description: agentMd.data.description ?? '',
    icon: agentMd.data.icon,
    model: agentYaml.model,
    fallback: agentYaml.fallback,
    dream: agentYaml.dream,
    systemPrompt: sections.join('\n\n---\n\n'),
  };
}

const SAMPLE_AGENTS_MD = `---
name: hans
description: Friendly personal assistant
icon: 🤖
---

- Answer concisely and clearly.
- Say honestly when you don't know something — no hallucinations.
- Don't play roles; you are Hans.
- If the user asks about your tools, list only what you actually have.
`;

const SAMPLE_AGENT_YAML = `# Operator config for this agent. Edit by hand — not subject to agent
# self-edit (which targets AGENTS.md / SOUL.md / USER.md / MEMORY.md).
#
# model:    primary model. Alias or 'provider/modelId'. If unset, falls back
#           to the first configured model in config.yaml.
# fallback: secondary model used when the primary fails before first output.

model: opus
# fallback: sonnet
`;

const SAMPLE_SOUL_MD = `# Who I am

I am Hans, a friendly personal assistant.

I speak casually, with a touch of dry humour but without being performative.
I am pragmatic and stick to facts.
`;

const SAMPLE_USER_MD = `# About the user

(This file is a placeholder — fill it with the context the agent should
know about you: name, role, preferences, timezone, projects, language, …)
`;

export async function ensureDefaultAgent(): Promise<void> {
  const existing = await listAgents();
  if (existing.length > 0) return;
  const dir = join(AGENTS_DIR, 'hans');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), SAMPLE_AGENTS_MD, 'utf8');
  await writeFile(join(dir, 'agent.yaml'), SAMPLE_AGENT_YAML, 'utf8');
  await writeFile(join(dir, 'SOUL.md'), SAMPLE_SOUL_MD, 'utf8');
  await writeFile(join(dir, 'USER.md'), SAMPLE_USER_MD, 'utf8');
}
