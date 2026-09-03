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

// somora-emitted by every CLI adapter: the engine-side session was
// restarted because somora's MCP server name changed (the old session
// knew the tools under `mcp__<old>__*`). History is replayed.
const MCP_SERVER_RENAMED = 'session restarted';

export const ENGINE_META_LABELS: Record<string, Record<string, string>> = {
  'codex-cli': {
    todo_list: 'plan',
    // somora-emitted (not from the codex wire): the adapter re-threaded
    // the codex session because the selected model changed.
    model_switch: 'model switch',
    mcp_server_renamed: MCP_SERVER_RENAMED,
  },
  'claude-cli': {
    mcp_server_renamed: MCP_SERVER_RENAMED,
  },
  'grok-cli': {
    mcp_server_renamed: MCP_SERVER_RENAMED,
  },
  'openai-compatible': {
    // somora-emitted: the backend rejected the prompt as too long, the
    // engine forced a compaction and retried the turn.
    context_compacted: 'context compacted',
    // somora-emitted: the backend rejected the reasoning-effort value,
    // the engine retried with a neighbour (or without the param).
    reasoning_effort_adjusted: 'reasoning effort adjusted',
    // somora-emitted: the backend rejected a sampling key (temperature,
    // top_p, …), the engine retried without sampling.
    sampling_dropped: 'sampling dropped',
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
 * codex todo_list actual payload shape (verified 2026-05-19 against
 * codex-cli 0.130 emitting from GPT-5.5 update_plan):
 *   { id: string, type: "todo_list",
 *     items: [{ text: string, completed: boolean }, ...] }
 *
 * The pre-.19.05 implementation guessed `content`/`status` strings (an
 * earlier assumption that turned out wrong on the wire) — keep tolerant
 * fallbacks for both shapes so a future codex protocol bump doesn't
 * silently empty the panel.
 */
export function summariseEngineMeta(
  engine: string,
  itemType: string,
  payload: unknown,
): string | undefined {
  if (itemType === 'mcp_server_renamed') {
    const p = payload as { text?: unknown; from?: unknown; to?: unknown } | null | undefined;
    if (p && typeof p.text === 'string') return p.text;
    return `engine session restarted after the MCP server rename (${typeof p?.from === 'string' ? p.from : 'somora-memory'} → ${typeof p?.to === 'string' ? p.to : 'somora'})`;
  }
  if (engine === 'codex-cli' && itemType === 'model_switch') {
    const p = payload as { text?: unknown; from?: unknown; to?: unknown } | null | undefined;
    if (p && typeof p.text === 'string') return p.text;
    if (p && typeof p.from === 'string' && typeof p.to === 'string') {
      return `codex thread restarted for model switch ${p.from} → ${p.to}`;
    }
    return undefined;
  }
  if (engine === 'openai-compatible' && itemType === 'sampling_dropped') {
    const p = payload as { text?: unknown } | null | undefined;
    return p && typeof p.text === 'string' ? p.text : 'sampling parameters rejected by the backend — sent without them';
  }
  if (engine === 'openai-compatible' && itemType === 'reasoning_effort_adjusted') {
    const p = payload as { text?: unknown; requested?: unknown; sent?: unknown } | null | undefined;
    if (p && typeof p.text === 'string') return p.text;
    if (p && typeof p.requested === 'string') {
      return `reasoning effort '${p.requested}' rejected by the backend — sent ${typeof p.sent === 'string' ? `'${p.sent}'` : 'without the parameter'} instead`;
    }
    return undefined;
  }
  if (engine === 'openai-compatible' && itemType === 'context_compacted') {
    const p = payload as { text?: unknown } | null | undefined;
    return p && typeof p.text === 'string' ? p.text : 'history compacted after a context overflow';
  }
  if (engine === 'codex-cli' && itemType === 'todo_list') {
    const items = extractTodoListItems(payload);
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

/**
 * Extract the renderable task list from a codex todo_list payload.
 * Returns null for any payload that doesn't look like the known shape
 * AT ALL, so callers can fall back to raw-json rendering. Otherwise
 * returns the normalized `{content, status}` array — `completed: true`
 * becomes `status: 'completed'`, `false` becomes `status: 'pending'`.
 * Tolerant of legacy `content`/`status` field names as a fallback.
 */
export function extractTodoListItems(
  payload: unknown,
): Array<{ content: string; status: string }> | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { items?: unknown }).items;
  if (!Array.isArray(raw)) return null;
  const out: Array<{ content: string; status: string }> = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const obj = it as Record<string, unknown>;
    // Real codex 0.130 shape: { text, completed }.
    // Tolerant fallback: { content, status } (in case codex's protocol
    // ever flips to that — keeps the renderer alive across a bump).
    const text =
      typeof obj.text === 'string'
        ? obj.text
        : typeof obj.content === 'string'
          ? obj.content
          : '';
    if (!text) continue;
    let status: string;
    if (typeof obj.status === 'string') {
      status = obj.status;
    } else if (typeof obj.completed === 'boolean') {
      status = obj.completed ? 'completed' : 'pending';
    } else {
      status = 'pending';
    }
    out.push({ content: text, status });
  }
  return out;
}
