// Pre-formats tool-call args and tool-result outputs into the one-line
// summaries that go on the SSE wire. Lives server-side so every client
// (TUI, future Orbit/web) renders the same text without needing to know
// individual tool schemas.
//
// Conventions:
//   - shortToolName strips the `mcp__<server>__` prefix that claude-cli /
//     codex-cli wrap MCP tool names in. Clients receive clean names.
//   - formatArgs returns '' when there's nothing useful beyond the tool
//     name itself (the call line will just show the tool).
//   - formatResult returns null for trivial successes (e.g. {ok:true}
//     after a write); callers should suppress the result row entirely.
//   - Unknown tools fall back to a generic shape-based formatter — show
//     the first one or two scalar fields, truncate the rest.

export function shortToolName(tool: string): string {
  return tool.replace(/^mcp__[^_]+__/, '');
}

export function formatArgs(toolFq: string, input: unknown): string {
  const name = shortToolName(toolFq);
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  switch (name) {
    case 'memory_search': {
      const query = obj.query;
      const ms = obj.minScore;
      const limit = obj.limit;
      const parts: string[] = [];
      if (typeof query === 'string') parts.push(`query="${query}"`);
      if (typeof limit === 'number') parts.push(`limit=${limit}`);
      if (typeof ms === 'number' && ms !== 0.5) parts.push(`minScore=${ms}`);
      return parts.join(' · ');
    }
    case 'memory_get':
      return typeof obj.reference === 'string' ? obj.reference : '';
    case 'memory_write':
    case 'memory_edit':
    case 'memory_delete':
      return typeof obj.slug === 'string' ? `slug=${obj.slug}` : '';
    case 'memory_list':
      return typeof obj.filter === 'string' ? `filter=${obj.filter}` : '';
    case 'dream_list':
      return obj.include_processed === true ? 'include_processed' : '';
    case 'dream_get':
      return typeof obj.dream_id === 'string' ? `dream_id=${obj.dream_id}` : '';
    case 'dream_apply':
    case 'dream_dismiss': {
      const id = obj.dream_id;
      const fid = obj.finding_id;
      const parts: string[] = [];
      if (typeof id === 'string') parts.push(`dream=${id}`);
      if (typeof fid === 'number') parts.push(`finding=${fid}`);
      return parts.join(' · ');
    }
    default:
      return summarize(input, 100);
  }
}

export function formatResult(toolFq: string, output: unknown): string | null {
  const name = shortToolName(toolFq);
  if (output === undefined || output === null) return null;
  // Bare {ok:true} is the most common "trivial success" pattern — suppress
  // unless the tool is one where details matter.
  if (
    typeof output === 'object' &&
    output !== null &&
    Object.keys(output as object).length === 1 &&
    (output as Record<string, unknown>).ok === true
  ) {
    return null;
  }
  const obj =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>)
      : null;

  switch (name) {
    case 'memory_search': {
      if (!obj) return null;
      const count = typeof obj.count === 'number' ? obj.count : null;
      const hits = Array.isArray(obj.hits) ? (obj.hits as Array<Record<string, unknown>>) : [];
      const top = hits[0];
      if (count === 0 || hits.length === 0) return '0 hits';
      const ref = top && typeof top.reference === 'string' ? top.reference : '?';
      const score = top && typeof top.score === 'number' ? top.score : null;
      const scoreStr = score !== null ? ` (${score.toFixed(2)})` : '';
      return `${count ?? hits.length} hits · top: ${ref}${scoreStr}`;
    }
    case 'memory_get': {
      if (!obj) return null;
      const slug = typeof obj.slug === 'string' ? obj.slug : null;
      const content = typeof obj.content === 'string' ? obj.content : null;
      if (slug && content !== null) return `${slug} · ${content.length} chars`;
      return null;
    }
    case 'memory_list': {
      if (!obj) return null;
      const count = typeof obj.count === 'number' ? obj.count : null;
      return count !== null ? `${count} notes` : null;
    }
    case 'memory_write':
    case 'memory_edit':
    case 'memory_delete':
      // After the call line shows slug=…, the {ok:true} response is
      // already implicit. Suppress.
      return null;

    case 'dream_list': {
      if (!obj) return null;
      const count = typeof obj.count === 'number' ? obj.count : null;
      return count !== null ? `${count} pending` : null;
    }
    case 'dream_get': {
      if (!obj) return null;
      const findings = Array.isArray(obj.findings) ? obj.findings.length : null;
      return findings !== null ? `${findings} findings` : null;
    }
    case 'dream_apply': {
      if (!obj) return null;
      const applied = obj.applied === true;
      const remaining = typeof obj.remaining === 'number' ? obj.remaining : null;
      const done = obj.dream_done === true;
      const parts: string[] = [];
      if (applied) parts.push('applied');
      if (remaining !== null) parts.push(`${remaining} left`);
      if (done) parts.push('dream done');
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    case 'dream_dismiss': {
      if (!obj) return null;
      const done = obj.dream_done === true;
      return done ? 'dismissed · dream done' : 'dismissed';
    }

    default:
      return summarize(output, 100);
  }
}

function summarize(value: unknown, maxLen: number): string {
  if (value === undefined || value === null) return '';
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '';
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd() + '…';
  return s;
}

// Pretty-printed full payload for /verbose tools. Strings stay as-is;
// objects/arrays get JSON.stringify with indent. Always emitted on the
// wire; clients render only when /verbose tools is on.
export function formatDetails(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
