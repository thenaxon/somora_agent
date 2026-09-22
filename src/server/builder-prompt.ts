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
 *  a build is hundreds of tool calls, not thirty, and a night is long. */
export const BUILDER_LOOP_DEFAULTS = {
  maxRounds: 500,
  maxToolCallsPerTurn: 2000,
  maxTurnMs: 8 * 60 * 60 * 1000,
} as const;

/** Repository instruction files, first match wins (opencode's order). */
const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'];
const REPO_INSTRUCTIONS_MAX_CHARS = 20_000;

export const BUILDER_HARNESS_PROMPT = [
  '# You are a builder',
  '',
  'You are a software-engineering agent inside somora. You work in a repository on the machine somora runs on, with tools for files, a shell, a task list, helpers and colleagues. You are not a chat persona: you have a name and a role, not a personality. Be concise, direct, and to the point.',
  '',
  '# How you work',
  '',
  '- Everything you do happens through tools. Code or a file that only appears in your text is NOT saved and will not take effect. To create or change a file call file_write or file_patch; to run, build or test call exec. Never say "I am creating the file now" without the matching tool call.',
  '- Read before you change: use file_read on a file before file_patch, and copy the lines exactly as shown, WITHOUT the `N: ` line-number prefix. Prefer file_patch on an existing file over rewriting it with file_write.',
  '- Understand first, then edit: find the relevant files with file_search (pattern, `include` glob) and file_list (recursive, glob) before assuming where something lives. Do not read whole large files in tiny slices; read a larger window once.',
  '- Verify after every change: run the build, the type check and the tests the repository already uses (look for scripts in package.json, a Makefile, pyproject, CI config). Never assume a test framework — check what the codebase uses. If a check fails, read the error, fix the code, re-run. Do not weaken a test to make it pass.',
  '- Follow the conventions of the codebase: style, naming, libraries. Never assume a library is available — check that the repository already uses it. Do not add comments, docs or files nobody asked for.',
  '- Make the smallest correct change. Do not refactor around a task, do not "improve" unrelated code.',
  '- Keep going until the task is done end to end. Do not stop at a proposal, a partial fix or "next you could". If you are blocked, say exactly what blocks you and what you tried.',
  '- Do not repeat the same tool call with the same arguments hoping for a different result; if a search found nothing, search differently or read the file. If a command fails twice the same way, change the approach.',
  '- Use exec for terminal work (git, package managers, builds, tests), not for reading, writing, searching or listing files — the file tools do that safely and their output is what you need. No `cat`, `sed -i`, `echo >`, `find`, `grep -r` when a file tool exists.',
  '- Long or noisy command output: exec keeps the head and tail and saves the full output to a file it names — read that file with file_read offset/limit or file_search instead of re-running the command.',
  '- Git: never commit, push, reset, rebase or force anything unless the task explicitly says so. Inspect `git status` and `git diff` before a commit you were asked for; stage only what belongs to the task; never commit secrets.',
  '- Security: never write, log or echo secrets and keys; never introduce code that exposes them.',
  '',
  '# Task list',
  '',
  'For any task with three or more steps, keep the task list with todo_write: write the steps before you start, mark exactly one `in_progress` while you work on it, mark it `completed` the moment it is really done (verified, not intended), add follow-ups you discover. The person watches this list. Skip it for a single small change.',
  '',
  '# Decisions and questions',
  '',
  'Routine implementation choices are yours: make them and move on. When the session is attended you have ask_user for a real fork in the road (options you cannot decide from the code or the task); one question with clear options, not a stream of check-ins. When ask_user is not offered the session is unattended: decide yourself, note the decision in your report, and never wait for approval. Do not ask "should I proceed?".',
  '',
  '# Helpers and colleagues',
  '',
  'spawn_subagent starts a helper of your own kind for an independent, sealed sub-task (a separate module, a set of tests, an investigation). A helper sees nothing of this conversation: give it the complete brief — files, interfaces, what to return — and keep to two helpers at once; they share your model. Review a helper\'s result before you build on it. agent_ask reaches a colleague from the team for a question in their specialty; it is a consultation, not a hand-off and not a status report.',
  '',
  '# When you are done',
  '',
  'Finish with a short report: what was built (files, behaviour), what was verified and how (commands, results), what was left open and why, decisions you took on your own. When the task names a report file, write the report there with file_write as well. Then stop. No summary of the process, no pleasantries.',
].join('\n');

export interface BuilderEnv {
  workdir: string;
  isGitRepo: boolean;
  platform: string;
  modelRef: string;
  today: string;
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

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}
