// Process-wide store for fire-and-forget subagent tasks. spawn_subagent
// with wait:false enqueues a background runChatTurn promise here; the
// invoking agent gets a task_id back and can later check status /
// fetch result via subagent_status / subagent_result tools.
//
// Lifecycle: tasks are kept in memory for the server's lifetime. On
// process restart they're lost — sub-sessions persist in JSONL, but
// the in-memory task entries do not. Acceptable for v1; persistent
// async-task storage is on the FUTURE list if it becomes a pain.

import type { ChatTurnResult } from './run-turn-types.ts';

export type AsyncTaskState = 'running' | 'done' | 'failed';

export interface AsyncTaskEntry {
  task_id: string;
  state: AsyncTaskState;
  parent_agent: string;
  parent_session: string;
  target_agent: string;
  target_session: string;
  started_at: number;
  finished_at?: number;
  result?: ChatTurnResult;
  error?: string;
}

const tasks = new Map<string, AsyncTaskEntry>();

export function newTaskId(): string {
  // Short, URL-safe, alphabet-only — easier to read in logs than a UUID.
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `task_${ts}_${rnd}`;
}

export function registerTask(entry: Omit<AsyncTaskEntry, 'state'>): AsyncTaskEntry {
  const stored: AsyncTaskEntry = { ...entry, state: 'running' };
  tasks.set(entry.task_id, stored);
  return stored;
}

export function completeTask(task_id: string, result: ChatTurnResult): void {
  const e = tasks.get(task_id);
  if (!e) return;
  e.state = result.error ? 'failed' : 'done';
  e.result = result;
  e.finished_at = Date.now();
  if (result.error) e.error = result.error;
}

export function failTask(task_id: string, error: string): void {
  const e = tasks.get(task_id);
  if (!e) return;
  e.state = 'failed';
  e.error = error;
  e.finished_at = Date.now();
}

export function getTask(task_id: string): AsyncTaskEntry | undefined {
  return tasks.get(task_id);
}

export function listTasksForAgent(parent_agent: string): AsyncTaskEntry[] {
  return [...tasks.values()].filter((t) => t.parent_agent === parent_agent);
}
