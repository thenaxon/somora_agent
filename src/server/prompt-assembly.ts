// System-prompt assembly — ONE place that decides what static text an
// agent gets in front of the conversation, in which order, with which
// separators. Used by run-turn for the real turn and by
// GET /agents/:agent/prompt-preview for the web Agent window, so what
// the window shows is byte-identical to what the model receives.
//
// Order (static → volatile, for prefix caching):
//   self-pointer · persona (SOUL / AGENTS / USER) · team · tool reminder
//   · wiki overview (session snapshot) · skills · project
//
// Not part of this text, by design: tool schemas (API tool channel),
// the per-turn memory recall (user-message side), the history, and the
// engines' own built-in instructions.

import type { Config } from '../config/types.ts';
import { getFreshConfig } from '../config/loader.ts';
import type { Persona } from '../persona/loader.ts';
import { readProject } from '../projects/store.ts';
import { renderProjectBlock } from '../projects/prompt-block.ts';
import { loadAvailableSkills } from '../skills/load.ts';
import { buildSkillsRegistry } from '../skills/registry.ts';
import { getMemoryManager } from '../memory/registry.ts';
import { buildTeamBlock } from '../team/store.ts';
import { logger } from './logger.ts';
import { SOMORA_HOME_DIR } from './logger.ts';
import type { ChatTurnResolveDeps } from './run-turn-types.ts';
import { buildSelfPointer, effectiveWorkspace } from './workspace.ts';
import { readBuilderState, renderBuilderSessionBlock } from './builder-session.ts';
import {
  BUILDER_HARNESS_PROMPT,
  isGitRepo,
  readRepoInstructions,
  renderBuilderEnvBlock,
  renderBuilderIdentity,
  renderRepoInstructionsBlock,
} from './builder-prompt.ts';

export const TOOL_USAGE_REMINDER = [
  '## Tools',
  '',
  'You have tools available. They are passed to you through the API tool',
  'channel, not listed in this text — they are present even when the',
  'conversation history above happens to show no tool calls.',
  '',
  'Never describe an execution in words alone. If you want to write a',
  'file, run a command, or look something up, call the corresponding',
  'tool. A sentence like "I am creating the file now" without the',
  'matching tool call is a failure: nothing happens, and the user waits',
  'for a result that will never arrive.',
].join('\n');

/**
 * Build the project-block portion of the system prompt. Returns the
 * empty string when:
 *   - config.projects is missing or `enabled: false`
 *   - session has no `projectSlug` (nothing pinned)
 *   - the slug points at a missing file (warn-log + soft-degrade)
 *
 * Reads from disk every turn so a `project_update` lands in the next
 * turn's prompt without any cache-invalidation step. The pure-frontmatter
 * file format keeps this read cheap.
 */
export async function buildProjectBlock(
  sessionMeta: Record<string, unknown>,
  config: Config,
): Promise<string> {
  if (!config.projects?.enabled) return '';
  const slug = sessionMeta.projectSlug;
  if (typeof slug !== 'string' || slug.length === 0) return '';
  try {
    const project = await readProject(slug);
    if (!project) {
      logger.warn({
        msg: 'project.focused_but_missing',
        slug,
        hint: 'session.meta points at a project file that no longer exists; project block will be empty',
      });
      return '';
    }
    return renderProjectBlock(project);
  } catch (err) {
    logger.warn({
      msg: 'project.load_failed',
      slug,
      err: (err as Error).message,
    });
    return '';
  }
}

/** Key under which the per-session wiki-overview snapshot is persisted. */
export const WIKI_OVERVIEW_META_KEY = 'wikiOverview';

/**
 * Wiki overview block — snapshotted into the session meta on first use
 * so it stays byte-stable for the session's lifetime (prefix cache).
 * `persist: false` (the preview route) renders without writing the
 * snapshot, so looking at a prompt never changes a session.
 */
export async function buildWikiOverviewBlock(
  agent: string,
  session: string,
  sessionMeta: Record<string, unknown>,
  deps: ChatTurnResolveDeps,
  persist = true,
): Promise<string> {
  if (!deps.config.wiki.enabled) return '';
  const cached = sessionMeta[WIKI_OVERVIEW_META_KEY];
  if (typeof cached === 'string') return renderWikiOverviewBlock(cached);
  let text = '';
  try {
    const mgr = await getMemoryManager(agent, {
      config: deps.config.memory,
      wiki: deps.config.wiki,
      obsidian: deps.config.obsidian,
    });
    text =
      (await mgr.getWikiOverview({
        maxChars: deps.config.wiki.search.overviewMaxChars,
        topNSlugs: deps.config.wiki.search.overviewTopNSlugs,
      })) ?? '';
  } catch (err) {
    // Soft-degrade: a missing overview costs discoverability, not the turn.
    // Not snapshotted either, so the next turn retries.
    logger.warn({ msg: 'wiki.overview_failed', agent, session, err: (err as Error).message });
    return '';
  }
  if (persist) {
    await deps.sessionMetaStore.update(agent, session, (current) => ({
      ...current,
      [WIKI_OVERVIEW_META_KEY]: text,
    }));
    logger.info({ msg: 'wiki.overview_snapshotted', agent, session, chars: text.length });
  }
  return renderWikiOverviewBlock(text);
}

function renderWikiOverviewBlock(text: string): string {
  if (text.length === 0) return '';
  return (
    `\n\n---\n\n## Wiki overview (shared long-term knowledge)\n\n` +
    `A map of what the shared wiki holds, as it stood when this session ` +
    `started — page names and topics only, no content, and it does not ` +
    `list your own memory notes. Read a page with ` +
    `\`memory_get('wiki/<path>')\` or search across memory, wiki and vault ` +
    `with \`memory_search\`.\n\n${text}`
  );
}

export type PromptPartKey = 'self' | 'persona' | 'team' | 'tools' | 'wiki' | 'skills' | 'session' | 'project';

/**
 * Which session this is. Without it an agent cannot name the
 * conversation it is working in — and every tool that takes a session
 * falls back to `main`, a different conversation. Two incidents
 * (2026-09-14/15): a resume trigger set from a working session fired in
 * `main` and ran alongside the work it was meant to resume; a project
 * report went to the orchestrator's `main` instead of its project
 * session.
 *
 * Static for the life of a session, and placed after everything that
 * sessions of one agent share (self-pointer … skills), so a backend
 * with prefix caching keeps the shared prefix across sessions.
 */
export function buildSessionBlock(agent: string, session: string, sessionMeta: Record<string, unknown>): string {
  const slug = typeof sessionMeta.slug === 'string' && sessionMeta.slug.length > 0 ? sessionMeta.slug : session;
  const idNote = slug === session ? '' : ` (id \`${session}\`)`;
  return [
    '\n\n---\n',
    '## This session',
    `You are working in session \`${slug}\`${idNote} of agent \`${agent}\`. "Session" in somora means a chat session like this one — not a tmux session.`,
    `When something should come back HERE — a sentinel trigger that resumes this work, an agent told where to report — name this session. A sentinel trigger you set on yourself fires here unless you name another session; \`agent_ask\` without a session goes to the target's \`main\`${slug === 'main' ? '' : ', which may not know this context'}.`,
  ].join('\n');
}

export interface PromptPart {
  key: PromptPartKey;
  label: string;
  /** Exact bytes this part contributes, separators included — the
   *  parts concatenate to `text`. */
  text: string;
}

export interface AssembledPrompt {
  text: string;
  parts: PromptPart[];
  /** Kept separately: codex-cli re-sends it on resumed threads. */
  projectBlock: string;
}

export async function assembleSystemPrompt(args: {
  agent: string;
  session: string;
  persona: Persona;
  sessionMeta: Record<string, unknown>;
  deps: ChatTurnResolveDeps;
  subagentDepth: number;
  /** Number of tools the agent can see — the tool reminder is only
   *  worth its bytes when there is something to call. */
  toolCount: number;
  /** false = preview: never write the wiki snapshot into the session. */
  persistWikiSnapshot?: boolean;
}): Promise<AssembledPrompt> {
  const { agent, session, persona, sessionMeta, deps, subagentDepth, toolCount } = args;
  // Self-pointer from FRESH config so newly-added resources appear on the
  // next turn instead of after a restart. Content derives from
  // config.resources + persona.resourceDeny + paths only, so it stays
  // stable across turns within a session (prefix-cache impact nil).
  const freshConfig = await getFreshConfig();
  if (persona.kind === 'builder') {
    return assembleBuilderPrompt({ ...args, freshConfig });
  }
  const selfPointer = buildSelfPointer(persona, freshConfig, SOMORA_HOME_DIR);
  const subContextNote =
    subagentDepth > 0
      ? `\n\nNote: this is a SUBAGENT turn (depth=${subagentDepth}). You were spawned by another agent to do a focused task; finish, return your result, and stop. What you return is what your parent gets: if you started sub-agents of your own, do not hand in your report while they are still working — wait for them (spawn with wait:true, or subagent_result with wait_until_done) and fold their results in.`
      : '';
  // Team block (team.yaml → "# Your team", src/team): first who I am,
  // then who the others are, then tools. Changes only with team.yaml or
  // the agent roster.
  const teamText = await buildTeamBlock(agent);
  const teamBlock = teamText ? `\n\n---\n\n${teamText}` : '';
  // Tool-usage reminder — constant text, BEFORE the more volatile
  // skills/project blocks. Gated on the agent actually having tools.
  const toolsBlock =
    deps.config.agentLoop.toolUsageReminder && toolCount > 0 ? `\n\n---\n\n${TOOL_USAGE_REMINDER}` : '';
  // Wiki overview — session-static by construction (snapshotted on the
  // first turn, then frozen), so it sits ABOVE skills and project.
  const wikiBlock = await buildWikiOverviewBlock(agent, session, sessionMeta, deps, args.persistWikiSnapshot !== false);
  // Skills — loaded fresh each turn so a SKILL.md edit takes effect on
  // the next turn; rare changes, ideal for the cached prefix.
  const allSkills = await loadAvailableSkills(freshConfig);
  const skillsRegistry = buildSkillsRegistry(allSkills, persona.skillGating, freshConfig);
  const skillsBlock = skillsRegistry.text ? `\n\n---\n\n${skillsRegistry.text}` : '';
  // Session — differs per session, static within one.
  const sessionBlock = buildSessionBlock(agent, session, sessionMeta);
  // Project — most volatile (changes on a /project switch), so last.
  const projectBlock = await buildProjectBlock(sessionMeta, deps.config);

  const parts: PromptPart[] = [
    { key: 'self', label: 'Self-pointer', text: `${selfPointer}${subContextNote}` },
    { key: 'persona', label: 'Persona (SOUL.md · AGENTS.md · USER.md)', text: `\n\n---\n\n${persona.systemPrompt}` },
    { key: 'team', label: 'Team block', text: teamBlock },
    { key: 'tools', label: 'Tool reminder', text: toolsBlock },
    { key: 'wiki', label: 'Wiki overview (session snapshot)', text: wikiBlock },
    { key: 'skills', label: 'Skills', text: skillsBlock },
    { key: 'session', label: 'This session', text: sessionBlock },
    { key: 'project', label: 'Project', text: projectBlock },
  ];
  return { text: parts.map((p) => p.text).join(''), parts, projectBlock };
}

/**
 * The builder variant (agent.yaml `kind: builder`): harness rules,
 * environment, the repository's own instructions, a compact team, the
 * tool reminder, skills, session and project. No persona prose, no wiki
 * map — see src/server/builder-prompt.ts. Same part keys as the chat
 * prompt so the web Agent window and the prompt-preview route render
 * it unchanged.
 */
async function assembleBuilderPrompt(args: {
  agent: string;
  session: string;
  persona: Persona;
  sessionMeta: Record<string, unknown>;
  deps: ChatTurnResolveDeps;
  subagentDepth: number;
  toolCount: number;
  freshConfig: Config;
}): Promise<AssembledPrompt> {
  const { agent, session, persona, sessionMeta, deps, subagentDepth, toolCount, freshConfig } = args;
  const workdir = effectiveWorkspace(persona, freshConfig);
  const env = renderBuilderEnvBlock({
    workdir,
    isGitRepo: await isGitRepo(workdir),
    platform: `${process.platform} ${process.arch}`,
    modelRef: `${persona.model ?? 'default model'}`,
    today: new Date().toISOString().slice(0, 10),
  });
  const helperNote =
    subagentDepth > 0
      ? `\n\nNote: this is a HELPER turn (depth=${subagentDepth}), started by another agent for one sealed sub-task. Do the task, return the result, stop.`
      : '';
  const identity = renderBuilderIdentity(persona);
  const repo = await readRepoInstructions(workdir);
  const teamText = await buildTeamBlock(agent, 'compact');
  const toolsBlock =
    deps.config.agentLoop.toolUsageReminder && toolCount > 0 ? `\n\n---\n\n${TOOL_USAGE_REMINDER}` : '';
  const allSkills = await loadAvailableSkills(freshConfig);
  const skillsRegistry = buildSkillsRegistry(allSkills, persona.skillGating, freshConfig);
  const skillsBlock = skillsRegistry.text ? `\n\n---\n\n${skillsRegistry.text}` : '';
  const modeBlock = renderBuilderSessionBlock(readBuilderState(sessionMeta));
  const sessionBlock = buildSessionBlock(agent, session, sessionMeta) + (modeBlock ? `\n\n${modeBlock}` : '');
  const projectBlock = await buildProjectBlock(sessionMeta, deps.config);

  const parts: PromptPart[] = [
    { key: 'self', label: 'Identity + environment', text: `${identity}\n\n${env}${helperNote}` },
    { key: 'persona', label: 'Builder harness rules', text: `\n\n---\n\n${BUILDER_HARNESS_PROMPT}` },
    { key: 'team', label: 'Team (compact)', text: teamText ? `\n\n---\n\n${teamText}` : '' },
    { key: 'tools', label: 'Tool reminder', text: toolsBlock },
    { key: 'wiki', label: 'Repository instructions', text: repo ? `\n\n---\n\n${renderRepoInstructionsBlock(repo)}` : '' },
    { key: 'skills', label: 'Skills', text: skillsBlock },
    { key: 'session', label: 'This session', text: sessionBlock },
    { key: 'project', label: 'Project', text: projectBlock },
  ];
  return { text: parts.map((p) => p.text).join(''), parts, projectBlock };
}
