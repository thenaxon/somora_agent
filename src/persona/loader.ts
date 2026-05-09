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
import { ThinkingLevelSchema, type ThinkingLevel } from '../config/types.ts';
import { logger } from '../server/logger.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const AGENTS_DIR = join(SOMORA_HOME, 'agents');

const VALID_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

const FrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    /** Optional display color (hex string e.g. "#5cf2d6"). Surfaced
     *  via /agents so the web client can color-tint per agent.
     *  When unset, the client falls back to a deterministic palette. */
    color: z.string().optional(),
    /** Optional short role-tag shown under the agent name in the
     *  web dock (e.g. "Orchestrator", "Coder"). Identity-level
     *  metadata, eligible for agent self-edit later — same channel
     *  as description/icon. */
    role: z.string().optional(),
  })
  .passthrough();

const RemConfigSchema = z.object({
  /** Master toggle. When false, REM-Phase never runs for this agent. */
  enabled: z.boolean(),
  /**
   * Worker model for extraction (alias or `provider/modelId`). Required
   * when enabled — there's intentionally no fallback to the agent's
   * primary, so a REM run never silently runs on an expensive model.
   */
  model: z.string().min(1),
  /**
   * Idle minutes before the auto-REM-trigger fires. Reset on every
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
   * marked as failed, the REM run continues with the next chunk.
   *
   * Default 600000ms (10 min). The earlier 2 min default was too tight
   * for realistic local-model loads — verified empirically 2026-05-06
   * with a real agent's main archive: 33k-token chunks against
   * gemma-4-31b-it-8bit via mlx-omx need 3-5 min just for prefill+
   * JSON-output, the 2 min
   * cap killed every chunk before it could complete (and before omlx's
   * KV cache could warm for the next chunk). 10 min is generous enough
   * to fit any reasonable local-model setup; faster cloud workers
   * complete in seconds and ignore the headroom.
   *
   * Lower this only if you're using a fast cloud worker AND want to
   * fail-fast on stalls. Most setups want the headroom.
   */
  chunkTimeoutMs: z.number().int().positive().default(600_000),
  /**
   * Phase 4: opt out of Deep-Phase (Memory→Wiki) for this agent.
   * When false, the agent's memory still gets REM processing but is
   * NOT considered as a candidate for promotion to the shared wiki.
   * Useful for scratch/test agents. Default true.
   */
  participate_in_wiki: z.boolean().default(true),
});

const AgentYamlSchema = z
  .object({
    model: z.string().optional(),
    fallback: z.string().optional(),
    /**
     * Persona-level thinking depth default. Overridable per-session via
     * `/thinking <level>`. Engine adapters apply it only if the active
     * model has the 'reasoning' capability — otherwise dormant.
     */
    thinking: ThinkingLevelSchema.optional(),
    /**
     * Per-agent workspace override. When set, file_* tools default to
     * this dir instead of the server-global `workspace.default`. Path
     * is auto-created (mkdir -p) at server start. ~ expands.
     */
    workspace: z
      .object({
        path: z.string().min(1),
      })
      .optional(),
    /**
     * Optional resource-visibility filter. By default the agent sees
     * every resource defined in config.yaml; `deny` hides individual
     * names. Allow-list semantics (only-these-are-visible) intentionally
     * not supported — keeps the config surface small.
     */
    resources: z
      .object({
        deny: z.array(z.string()).optional(),
      })
      .optional(),
    /**
     * Optional skills allow-list. When set (even to []), the agent only
     * sees the listed skills in its <available_skills> registry. When
     * unset, the agent sees ALL skills under ~/.somora/skills/. See
     * `private/skills-design.md` for the rationale (empty-list-means-
     * deny-all, missing-key-means-allow-all).
     */
    skills: z.array(z.string().min(1)).optional(),
    rem: RemConfigSchema.optional(),
  })
  .passthrough();

export type RemConfig = z.infer<typeof RemConfigSchema>;

type Frontmatter = z.infer<typeof FrontmatterSchema>;
type AgentYaml = z.infer<typeof AgentYamlSchema>;

export interface AgentInfo {
  name: string;
  description: string;
  icon: string | undefined;
  /** Optional hex display-color from AGENTS.md frontmatter. */
  color: string | undefined;
  /** Optional short role label from AGENTS.md frontmatter. */
  role: string | undefined;
}

export interface Persona {
  name: string;
  description: string;
  icon: string | undefined;
  model: string | undefined;
  fallback: string | undefined;
  thinking: ThinkingLevel | undefined;
  /**
   * Optional per-agent workspace override (resolved absolute path with
   * ~ expanded). When undefined, file_* tools fall back to the server-
   * global `config.workspace.default`.
   */
  workspace: string | undefined;
  /** Resource names this agent should NOT see in resource_list. */
  resourceDeny: string[];
  /**
   * Skill allow-list from agent.yaml. `undefined` or `[]` = no
   * restriction (agent sees all skills under ~/.somora/skills/);
   * `[name1, name2, ...]` = only those skills. Lenient interpretation
   * of "empty"; see `private/skills-design.md`.
   */
  skillsAllowList: string[] | undefined;
  rem: RemConfig | undefined;
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
      color: agentMd.data.color,
      role: agentMd.data.role,
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
    thinking: agentYaml.thinking,
    workspace: agentYaml.workspace?.path ? expandHome(agentYaml.workspace.path) : undefined,
    resourceDeny: agentYaml.resources?.deny ?? [],
    skillsAllowList: agentYaml.skills,
    rem: agentYaml.rem,
    systemPrompt: sections.join('\n\n---\n\n'),
  };
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// First-install seed agent. Operators are expected to rename / replace
// this with their own personas. The seed exists only so somora has
// SOMETHING to chat with right after install. Name kept neutral
// ('default') and content kept generic so it doesn't bias the
// operator's voice/character choices.
const DEFAULT_AGENT_NAME = 'default';

const SAMPLE_AGENTS_MD = `---
name: default
description: A neutral starter agent — rename and customize to your preference
icon: 🤖
---

- Answer concisely and clearly.
- Say honestly when you don't know something — no hallucinations.
- Don't play roles; you are who the operator says you are.
- If the user asks about your tools, list only what you actually have.
`;

const SAMPLE_AGENT_YAML = `# Operator config for this agent. Edit by hand — not subject to agent
# self-edit (which targets AGENTS.md / SOUL.md / USER.md / MEMORY.md).
#
# model:    primary model. Alias or 'provider/modelId'. If unset, falls back
#           to the first configured model in config.yaml.
# fallback: secondary model used when the primary fails before first output.
# thinking: cross-engine reasoning depth — off|low|medium|high. Engine
#           adapters apply it only if the active model has the 'reasoning'
#           capability. Per-session override via /thinking <level>.

model: opus
# fallback: sonnet
# thinking: medium
`;

const SAMPLE_SOUL_MD = `# Who I am

I am a neutral starter agent. The operator who installed me hasn't
yet told me who they want me to be — when they do, this file gets
rewritten with the actual character.

For now: I speak plainly and stick to facts.
`;

const SAMPLE_USER_MD = `# About the user

(This file is a placeholder — fill it with the context the agent should
know about you: name, role, preferences, timezone, projects, language, …)
`;

export async function ensureDefaultAgent(): Promise<void> {
  const existing = await listAgents();
  if (existing.length > 0) return;
  const dir = join(AGENTS_DIR, DEFAULT_AGENT_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), SAMPLE_AGENTS_MD, 'utf8');
  await writeFile(join(dir, 'agent.yaml'), SAMPLE_AGENT_YAML, 'utf8');
  await writeFile(join(dir, 'SOUL.md'), SAMPLE_SOUL_MD, 'utf8');
  await writeFile(join(dir, 'USER.md'), SAMPLE_USER_MD, 'utf8');
}
