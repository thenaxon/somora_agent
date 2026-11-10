// The system prompt of a Builder agent (agent.yaml `kind: builder`).
//
// A builder is a coding harness inside somora: the same server, session,
// tools and team, but in front of the conversation stands what a coding
// harness puts there — rules for working in a repository, an environment
// block, the repository's own instructions — instead of a persona's
// SOUL/USER prose, a wiki map and a recall block. Modelled on opencode's
// default prompt for models it does not know, with the sentences its
// Kimi and Trinity variants add for weaker models ("code in your text is
// not saved", "test after every change", "do not repeat a search in a
// loop"). See private/builder-research/ for the comparison.
//
// Everything here is session-static except the date line, so a
// prefix-caching backend keeps the prompt across turns of a day.

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Persona } from '../persona/loader.ts';

/** Loop caps a builder turn runs with unless agent.yaml says otherwise:
 *  a build is hundreds of tool calls, not thirty, and a night is long.
 *  No round cap: a round count says nothing about progress (DeepSeek-TUI
 *  and Hermes have none by default either), and the 500 of before ended
 *  night builds mid-work. What brakes a builder is the tool-call budget,
 *  the wall-clock cap and the loop guard. A number in agent.yaml
 *  (`agentLoop.maxRounds`) or in one call brings a cap back. */
export const BUILDER_LOOP_DEFAULTS = {
  maxRounds: Number.POSITIVE_INFINITY,
  maxToolCallsPerTurn: 2000,
  maxTurnMs: 8 * 60 * 60 * 1000,
} as const;

/**
 * The loop caps of one turn, most specific last: server config → the
 * kind's defaults (a builder turn is a build, not a chat) → the agent's
 * own agentLoop block → what this one call asked for. Only a builder
 * gets BUILDER_LOOP_DEFAULTS; a chat agent runs on the server config.
 */
export function resolveAgentLoop<T extends object>(
  serverLoop: T,
  kind: string | undefined,
  personaLoop: object | undefined,
  override: object | undefined,
): T & Partial<typeof BUILDER_LOOP_DEFAULTS> {
  return {
    ...serverLoop,
    ...(kind === 'builder' ? BUILDER_LOOP_DEFAULTS : {}),
    ...(personaLoop ?? {}),
    ...(override ?? {}),
  };
}

/** Repository instruction files, first match wins (opencode's order). */
const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'];
const REPO_INSTRUCTIONS_MAX_CHARS = 20_000;

/**
 * The harness rules, for the tools this session actually offers: a
 * section that names a hidden tool (task list without todo_write,
 * questions without ask_user, helpers without spawn_subagent) is left
 * out, the same way a hidden tool's description is not sent.
 *
 * Short on purpose. Measured 2026-11-09/10 against the DeepSeek
 * harness on the same model (private/builder-research/
 * 2026-11-09_dsh-vs-somora/ABSCHLUSSBERICHT.md): a nine-line prompt of
 * tool rules did every task at least as well as the earlier 8.4k-char
 * method prompt (tests as proof, evidence layers, task-list duties),
 * and better on the hardest one. What a builder needs is how to use
 * its tools, to run what it built — and to look at a user interface
 * instead of only testing it.
 */
export function buildBuilderHarnessPrompt(visible: ReadonlySet<string> | null = null): string {
  const has = (name: string): boolean => visible === null || visible.has(name);
  const canEdit = has('file_write') || has('file_patch');
  const lines: string[] = [
    '# You are a builder',
    '',
    'You are a coding agent. You work in the working directory below with file tools and a shell. Keep answers brief and factual.',
    '',
    '# How you work',
    '',
    '- Everything happens through tools. Code or a file that only appears in your text is NOT saved.' +
      (canEdit ? ' Create and change files with file_write and file_patch.' : '') +
      (has('exec') ? ' Run, build and test with exec.' : ''),
  ];
  if (has('file_patch')) {
    lines.push(
      '- Read a file with file_read before you change it, unless you wrote it yourself in this session. Copy lines WITHOUT the `N: ` line-number prefix. Prefer file_patch for a targeted change; write a new file whole with file_write.',
    );
  }
  lines.push(
    '- Find files with file_list and file_search and read them with file_read (offset and limit for large files)' +
      (has('exec') ? ' — not with cat, find, grep or sed through exec.' : '.'),
  );
  if (has('exec')) {
    lines.push(
      '- Check the exit code of every exec result and investigate a failure before moving on. Do not repeat the same tool call with the same arguments hoping for a different result; change the approach.',
      '- Verify your work by running it: in an existing project its own tests and build; something new, run it. For a web page or a game, open it in a headless browser, take a screenshot and look at it with file_read — a test does not show you what a person sees.',
      '- Start a long-running command (a dev server) with background:true and do not poll it in a loop; stop what you started before you finish. Long output is cut and saved to a file the result names: read that file instead of running the command again.',
      '- A file write refused because the folder is outside the session is a boundary: never make the same change with exec. Name the folder you need in your report.',
      '- Git: never commit, push or reset unless the task says so.',
    );
  }
  lines.push(
    '- Follow the conventions of the codebase and change only what the task needs. Never write or print secrets.',
    '- Every response either moves the work forward with a tool call or is your final report. Keep going until the task is done; if you are blocked, say what blocks you.',
  );
  if (has('todo_write')) {
    lines.push('', '# Task list', '', 'For work with several steps you can keep a task list with todo_write; the person sees it.');
  }
  if (has('acceptance_write')) {
    lines.push(
      '',
      '# Acceptance list',
      '',
      'When the order requires an acceptance list ("Mode and phase" says so), keep it with acceptance_write: one item per requirement, passed or failed with the evidence, not_run when you did not check it.',
    );
  }
  lines.push('', '# Decisions and questions', '');
  lines.push(
    has('ask_user')
      ? 'Routine choices are yours: make them and move on. Use ask_user only for a real fork you cannot decide from the code or the task — one question with clear options.'
      : 'Routine choices are yours. Nobody answers questions in this session: decide yourself, note the decision in your report, and never wait for approval.',
  );
  if (has('spawn_subagent') || has('agent_ask')) {
    lines.push('', '# Helpers and colleagues', '');
    const parts: string[] = [];
    if (has('spawn_subagent')) {
      parts.push(
        'spawn_subagent starts a helper for a sealed sub-task; it sees nothing of this conversation, so give it the complete brief. At most two at once, never two on the same file. Wait with subagent_result with wait:true. Never message a running helper.',
      );
    }
    if (has('agent_ask')) {
      parts.push('agent_ask reaches a colleague from the team for a question in their specialty.');
    }
    lines.push(parts.join(' '));
  }
  lines.push(
    '',
    '# Messages from somora',
    '',
    'A message that starts with `[somora]` comes from the harness, not from the person; follow it. `[somora] Message from <name>` is what a person or colleague sent while you worked. No `[somora]` notice replaces or shrinks your task.',
    '',
    '# When you are done',
    '',
    'A write or patch result may carry `errors` from the language server: fix them before moving on.',
    '',
    'Done means every requirement of the task is met and checked' +
      (has('exec') ? ' — read the output of a test or build, not only its exit code' : '') +
      '. Never invent output or results you did not produce.',
    '',
    'Finish with a short report: what you built, how you checked it, what is left open, decisions you took. When the task names a report file, write the report there too. Your final answer IS the report: whoever gave the order receives it when you stop. Never send it with agent_ask.',
  );
  return lines.join('\n');
}

/** The full harness text (every tool present) — for tests and docs. */
export const BUILDER_HARNESS_PROMPT = buildBuilderHarnessPrompt(null);

export interface BuilderEnv {
  workdir: string;
  isGitRepo: boolean;
  platform: string;
  modelRef: string;
  today: string;
  /** e.g. "typescript ✓, pyright — not installed (somora lsp install pyright)". */
  languageServers?: string;
}

export function renderBuilderEnvBlock(env: BuilderEnv): string {
  return [
    '# Environment',
    '',
    `- Working directory: ${env.workdir} (relative paths in the file tools and the default cwd of exec resolve here)`,
    `- Git repository: ${env.isGitRepo ? 'yes' : 'no'}`,
    `- Platform: ${env.platform}`,
    `- Model: ${env.modelRef}`,
    `- Today: ${env.today}`,
    ...(env.languageServers ? [`- Language servers (errors after each write): ${env.languageServers}`] : []),
  ].join('\n');
}

export interface RepoInstructions {
  file: string;
  text: string;
}

/**
 * The repository's own instructions for agents, when it has some:
 * `<workdir>/AGENTS.md`, else CLAUDE.md, else CONTEXT.md. Capped so a
 * novel of a file cannot eat the window; the cut is marked.
 */
export async function readRepoInstructions(workdir: string): Promise<RepoInstructions | null> {
  for (const name of REPO_INSTRUCTION_FILES) {
    const p = join(workdir, name);
    try {
      await access(p);
    } catch {
      continue;
    }
    try {
      let text = await readFile(p, 'utf8');
      if (text.length > REPO_INSTRUCTIONS_MAX_CHARS) {
        text = text.slice(0, REPO_INSTRUCTIONS_MAX_CHARS) + `\n\n[… cut at ${REPO_INSTRUCTIONS_MAX_CHARS} chars — read the rest with file_read ${p}]`;
      }
      return { file: p, text };
    } catch {
      continue;
    }
  }
  return null;
}

export function renderRepoInstructionsBlock(r: RepoInstructions): string {
  return [`# Instructions from ${r.file}`, '', r.text.trim()].join('\n');
}

/** One line that says who this builder is, in place of a persona. */
export function renderBuilderIdentity(persona: Persona): string {
  const role = (persona as { role?: string }).role;
  const parts = [`You are \`${persona.name}\``];
  if (role) parts.push(`(${role})`);
  const desc = persona.description?.trim();
  return desc ? `${parts.join(' ')}: ${desc}` : `${parts.join(' ')}.`;
}

/** The AGENTS.md body of a builder: its own rules, below the harness. */
export function renderBuilderRulesBlock(rules: string): string {
  const t = rules.trim();
  if (!t) return '';
  // The body may open with its own heading (dan's does): keep that one.
  return t.startsWith('# ') ? t : `# Rules for this builder\n\n${t}`;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}
