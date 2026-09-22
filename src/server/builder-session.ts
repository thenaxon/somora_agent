// Per-session state of a Builder agent (agent.yaml `kind: builder`):
// mode, phase, plan file, task list. Lives in the session meta file so
// it survives a restart and is readable from the MCP child.
//
//   mode   attended   — a person watches: ask_user is offered.
//          unattended — nobody answers: ask_user is hidden, the prompt
//                       says "decide yourself, note it in the report".
//   phase  plan       — read, search, ask; the only file the builder
//                       writes is the plan (plan_write). Ends with Go.
//          build      — the plan is approved (or a brief came in with a
//                       plan): edit, run, test, report.
//
// Defaults are set on the first turn of a session from where that turn
// came from: a person opening the session gets attended + plan (they
// are about to describe a project), an agent handing over a brief gets
// unattended + build (the plan is in the brief). Both are switches in
// the task panel and fields of PATCH …/builder.

import type { SessionMetaStore } from '../engine/types.ts';
import type { ToolGating } from '../tools/gating.ts';
import type { TurnOrigin } from '../types/turn-origin.ts';

export type BuilderMode = 'attended' | 'unattended';
export type BuilderPhase = 'plan' | 'build';

export interface TodoItem {
  content: string;
  /** pending | in_progress | completed | cancelled — kept as a string on
   *  purpose: a typo from a small model must not fail the call. */
  status: string;
  priority?: string;
}

export interface BuilderSessionState {
  mode: BuilderMode;
  phase: BuilderPhase;
  /** Absolute path of the plan file (plan_write writes here). */
  planPath: string | null;
  todos: TodoItem[];
  /** When the defaults were chosen (absent = not a builder session yet). */
  initializedAt?: number;
}

export const DEFAULT_PLAN_FILE = 'PLAN.md';

/** Tools that change the repository — hidden while the phase is plan. */
const BUILD_ONLY_TOOLS: ReadonlySet<string> = new Set(['file_write', 'file_patch', 'process', 'spawn_subagent', 'subagent_result']);

export function readBuilderState(meta: Record<string, unknown>): BuilderSessionState | null {
  const mode = meta.builderMode;
  const phase = meta.builderPhase;
  if (mode !== 'attended' && mode !== 'unattended') return null;
  return {
    mode,
    phase: phase === 'plan' ? 'plan' : 'build',
    planPath: typeof meta.builderPlanPath === 'string' ? meta.builderPlanPath : null,
    todos: Array.isArray(meta.todos) ? (meta.todos as TodoItem[]) : [],
    ...(typeof meta.builderInitializedAt === 'number' ? { initializedAt: meta.builderInitializedAt } : {}),
  };
}

/** Defaults from the origin of the session's first turn. */
export function defaultBuilderState(origin: TurnOrigin, workdir: string): BuilderSessionState {
  const human = origin.kind === 'human';
  return {
    mode: human ? 'attended' : 'unattended',
    phase: human ? 'plan' : 'build',
    planPath: `${workdir.replace(/\/+$/, '')}/${DEFAULT_PLAN_FILE}`,
    todos: [],
    initializedAt: Date.now(),
  };
}

/** Make sure the session carries builder state; returns it. */
export async function ensureBuilderState(
  store: SessionMetaStore,
  agent: string,
  session: string,
  origin: TurnOrigin,
  workdir: string,
): Promise<BuilderSessionState> {
  const meta = await store.get(agent, session);
  const existing = readBuilderState(meta as Record<string, unknown>);
  if (existing) return existing;
  const fresh = defaultBuilderState(origin, workdir);
  await store.update(agent, session, (current) => ({
    ...current,
    builderMode: fresh.mode,
    builderPhase: fresh.phase,
    builderPlanPath: fresh.planPath,
    todos: fresh.todos,
    builderInitializedAt: fresh.initializedAt,
  }));
  return fresh;
}

export async function patchBuilderState(
  store: SessionMetaStore,
  agent: string,
  session: string,
  patch: Partial<Pick<BuilderSessionState, 'mode' | 'phase' | 'planPath' | 'todos'>>,
): Promise<BuilderSessionState> {
  const next = await store.update(agent, session, (current) => ({
    ...current,
    ...(patch.mode ? { builderMode: patch.mode } : {}),
    ...(patch.phase ? { builderPhase: patch.phase } : {}),
    ...(patch.planPath !== undefined ? { builderPlanPath: patch.planPath } : {}),
    ...(patch.todos ? { todos: patch.todos } : {}),
    ...(typeof (current as Record<string, unknown>).builderInitializedAt === 'number' ? {} : { builderInitializedAt: Date.now() }),
    ...((current as Record<string, unknown>).builderMode ? {} : { builderMode: patch.mode ?? 'attended' }),
    ...((current as Record<string, unknown>).builderPhase ? {} : { builderPhase: patch.phase ?? 'build' }),
  }));
  return readBuilderState(next as Record<string, unknown>)!;
}

/**
 * Which of a builder's tools this session offers right now. Applied on
 * top of the persona gating, in run-turn (openai-compatible) and in the
 * MCP child (claude-cli / codex-cli), so every engine sees the same
 * list.
 */
export function builderSessionAllows(state: BuilderSessionState | null, toolName: string): boolean {
  if (!state) return true;
  if (toolName === 'ask_user' && state.mode === 'unattended') return false;
  if (state.phase === 'plan' && BUILD_ONLY_TOOLS.has(toolName)) return false;
  return true;
}

/** The lines the builder prompt adds for the session's mode and phase. */
export function renderBuilderSessionBlock(state: BuilderSessionState | null, opts: { projectFolder?: boolean } = {}): string {
  if (!state) return '';
  const lines: string[] = ['## Mode and phase', ''];
  if (opts.projectFolder === false) {
    lines.push(
      state.mode === 'attended'
        ? '- No project folder is pinned to this session: the working directory above is the general workspace. Before building, find out which repository or folder the work belongs to — ask the person, or create the project with project_create (give it `workdir`) and pin it with project_focus; a pinned project makes its folder the working directory.'
        : '- No project folder is pinned to this session: the working directory above is the general workspace. Do not build there. Report that no project folder was given and stop.',
    );
  }
  if (state.mode === 'attended') {
    lines.push(
      '- Mode: ATTENDED. A person is watching this session. For a real fork in the road use ask_user (one question, clear options); for everything routine decide yourself and continue.',
    );
  } else {
    lines.push(
      '- Mode: UNATTENDED. Nobody will answer. Decide every open point yourself, note each decision in your report, and never stop to wait for approval.',
    );
  }
  if (state.phase === 'plan') {
    lines.push(
      `- Phase: PLAN. Read, search and run read-only commands to understand the repository and the task; ask what you must. The only file you write in this phase is the plan, with plan_write (it lands at ${state.planPath ?? DEFAULT_PLAN_FILE}). No other file changes, no builds that write, no commits. The plan lists goal, steps in order, files to touch, how to verify, open risks. When it is complete say "Plan ready" and stop — the person presses Go, and the session switches to BUILD.`,
    );
  } else {
    lines.push(
      `- Phase: BUILD. ${state.planPath ? `If a plan exists at ${state.planPath}, it is approved: read it first and execute it.` : 'Execute the task you were given.'} Keep the task list current with todo_write, verify as you go, and end with the report.`,
    );
  }
  return lines.join('\n');
}

/** Persona gating + session state as one predicate for a tool list. */
export function builderToolPredicate(
  gatingCheck: (name: string, toolset: string | undefined, gating: ToolGating | undefined) => boolean,
  gating: ToolGating | undefined,
  state: BuilderSessionState | null,
): (name: string, toolset: string | undefined) => boolean {
  return (name, toolset) => gatingCheck(name, toolset, gating) && builderSessionAllows(state, name);
}
