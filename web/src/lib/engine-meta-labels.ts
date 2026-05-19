// Client-side mirror of src/engine/engine-meta-labels.ts. Used when
// rendering engine_meta events that arrived via /chat/history (no
// server-side label-resolution on that path — history returns the raw
// JSONL row). For live SSE events the server already resolves the
// label and we use that directly.
//
// Keep this in sync with src/engine/engine-meta-labels.ts.

export const ENGINE_META_LABELS: Record<string, Record<string, string>> = {
  'codex-cli': {
    todo_list: 'plan',
  },
};

export function resolveEngineMetaLabel(engine: string, itemType: string): string {
  return ENGINE_META_LABELS[engine]?.[itemType] ?? itemType;
}

export interface TodoListItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export function extractTodoListItems(payload: unknown): TodoListItem[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { items?: unknown }).items;
  if (!Array.isArray(raw)) return null;
  const out: TodoListItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const content = typeof (it as { content?: unknown }).content === 'string'
      ? (it as { content: string }).content
      : '';
    const status = typeof (it as { status?: unknown }).status === 'string'
      ? (it as { status: string }).status
      : 'pending';
    if (!content) continue;
    const normalized: TodoListItem['status'] =
      status === 'in_progress' || status === 'completed' || status === 'cancelled'
        ? status
        : 'pending';
    out.push({ content, status: normalized });
  }
  return out;
}

export function summariseTodoList(items: TodoListItem[]): string {
  const total = items.length;
  if (total === 0) return 'plan cleared';
  let completed = 0;
  let inProgress = 0;
  for (const it of items) {
    if (it.status === 'completed') completed += 1;
    else if (it.status === 'in_progress') inProgress += 1;
  }
  const pieces = [`${total} task${total === 1 ? '' : 's'}`];
  if (completed > 0) pieces.push(`${completed} done`);
  if (inProgress > 0) pieces.push(`${inProgress} in progress`);
  return pieces.join(' · ');
}
