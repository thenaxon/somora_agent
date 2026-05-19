// Shared mapping of raw engine `itemType` strings to user-friendly
// labels for the chat UI. Server resolves the label at serialize time
// so all clients (web, TUI, future ones) see the same word without
// duplicating the table.
//
// Unknown itemTypes fall back to the raw string — that way future
// codex / claude-cli engine-meta events surface immediately with a
// reasonable label, even before we map them explicitly.
//
// Adding a new mapping: just append a line. The mapping table is
// engine-prefixed so e.g. claude-cli could ship its own `thinking`
// itemType later without conflicting with codex's namespace.

export const ENGINE_META_LABELS: Record<string, Record<string, string>> = {
  'codex-cli': {
    todo_list: 'plan',
  },
};

export function resolveEngineMetaLabel(engine: string, itemType: string): string {
  return ENGINE_META_LABELS[engine]?.[itemType] ?? itemType;
}

/**
 * Pretty one-liner summary for a known engine_meta payload. Returns
 * undefined for types we don't know how to summarise — clients fall
 * back to "(N keys)" or raw JSON in that case.
 *
 * codex todo_list payload shape (observed 2026-05-19):
 *   { id: string, type: "todo_list", items: [{id, content, status}, ...] }
 *   status ∈ {pending, in_progress, completed, cancelled}
 */
export function summariseEngineMeta(
  engine: string,
  itemType: string,
  payload: unknown,
): string | undefined {
  if (engine === 'codex-cli' && itemType === 'todo_list') {
    const items = extractTodoItems(payload);
    if (!items) return undefined;
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
  return undefined;
}

interface TodoItem {
  id?: string;
  content?: string;
  status?: string;
}

function extractTodoItems(payload: unknown): TodoItem[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { items?: unknown }).items;
  if (!Array.isArray(raw)) return null;
  return raw.filter((x): x is TodoItem => !!x && typeof x === 'object');
}

/**
 * Extract the renderable task list from a codex todo_list payload.
 * Returns null for any payload that doesn't look like the known shape,
 * so callers can fall back to raw-json rendering for unknown engines /
 * future schema changes.
 */
export function extractTodoListItems(
  payload: unknown,
): Array<{ content: string; status: string }> | null {
  const items = extractTodoItems(payload);
  if (!items) return null;
  const out: Array<{ content: string; status: string }> = [];
  for (const it of items) {
    const content = typeof it.content === 'string' ? it.content : '';
    const status = typeof it.status === 'string' ? it.status : 'pending';
    if (!content) continue;
    out.push({ content, status });
  }
  return out;
}
