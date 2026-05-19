// Session-export rendering. Two formats:
//   - json:     raw JSONL contents pasted line-by-line (the canonical
//               source-of-truth, byte-identical to ~/.somora/agents/
//               <agent>/sessions/<slug>.jsonl). Ideal for backups,
//               cross-host transfer, programmatic post-processing.
//   - markdown: human-readable transcript with user/assistant turns,
//               code-fenced tool calls, memory-inject banners. Loses
//               structural fidelity (no callId pairing, attachments
//               by name only) but reads naturally in Obsidian/GitHub.
//
// Both formats omit nothing — every event in the JSONL is reflected
// either as a transcript line (markdown) or 1:1 (json). engine_meta
// events are included; they reveal what the engine was internally
// tracking, which is part of the conversation record.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { homedir } from 'node:os';
import { resolveEngineMetaLabel, extractTodoListItems, summariseEngineMeta } from '../engine/engine-meta-labels.ts';

const STATUS_GLYPH: Record<string, string> = {
  completed: '✓',
  in_progress: '→',
  pending: '○',
  cancelled: '⊘',
};

interface JsonlEvent {
  kind?: string;
  ts?: number;
  engine?: string;
  text?: string;
  tool?: string;
  callId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  from_agent?: string;
  itemType?: string;
  payload?: unknown;
  attachments?: Array<{ name?: unknown; mime?: unknown; size?: unknown }>;
  audio?: { url?: unknown; mime?: unknown };
}

export function sessionJsonlPath(agent: string, session: string): string {
  return path.join(homedir(), '.somora', 'agents', agent, 'sessions', `${session}.jsonl`);
}

export function readSessionJsonlRaw(agent: string, session: string): string | null {
  const p = sessionJsonlPath(agent, session);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

export function renderSessionMarkdown(
  agent: string,
  session: string,
  jsonl: string,
): string {
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: string[] = [];
  out.push(`# Session ${session} · agent ${agent}`);
  out.push('');
  out.push(`Exported ${new Date().toISOString()}`);
  out.push('');

  const callIdToTool = new Map<string, string>();

  for (const line of lines) {
    let ev: JsonlEvent;
    try {
      ev = JSON.parse(line) as JsonlEvent;
    } catch {
      out.push('```');
      out.push(`<unparsable line> ${line.slice(0, 200)}`);
      out.push('```');
      continue;
    }
    const ts = typeof ev.ts === 'number' ? new Date(ev.ts).toISOString() : '';
    const tsLine = ts ? ` _(${ts})_` : '';

    switch (ev.kind) {
      case 'user_message': {
        const from = typeof ev.from_agent === 'string' ? ` (from ${ev.from_agent})` : '';
        out.push(`## 🧑 user${from}${tsLine}`);
        out.push('');
        out.push((ev.text ?? '').toString());
        out.push('');
        if (Array.isArray(ev.attachments) && ev.attachments.length > 0) {
          out.push('_attachments:_');
          for (const a of ev.attachments) {
            const name = typeof a.name === 'string' ? a.name : '?';
            const mime = typeof a.mime === 'string' ? a.mime : '?';
            const size = typeof a.size === 'number' ? a.size : 0;
            out.push(`- ${name} (${mime}, ${size} bytes)`);
          }
          out.push('');
        }
        break;
      }
      case 'assistant_message': {
        const engine = ev.engine ? ` _(${ev.engine})_` : '';
        out.push(`## 🤖 assistant${engine}${tsLine}`);
        out.push('');
        out.push((ev.text ?? '').toString());
        out.push('');
        break;
      }
      case 'tool_call': {
        const tool = typeof ev.tool === 'string' ? ev.tool : '?';
        if (typeof ev.callId === 'string') callIdToTool.set(ev.callId, tool);
        const input = ev.input ?? null;
        out.push(`<details><summary>🔧 tool call · <code>${escapeMd(tool)}</code></summary>`);
        out.push('');
        out.push('```json');
        out.push(safeJson(input));
        out.push('```');
        out.push('');
        out.push('</details>');
        out.push('');
        break;
      }
      case 'tool_result': {
        const tool =
          typeof ev.tool === 'string'
            ? ev.tool
            : (typeof ev.callId === 'string' && callIdToTool.get(ev.callId)) || '?';
        if (ev.error) {
          out.push(`> ⚠ tool error · \`${escapeMd(tool)}\` — ${escapeMd(String(ev.error))}`);
          out.push('');
        } else {
          out.push(`<details><summary>↳ tool result · <code>${escapeMd(tool)}</code></summary>`);
          out.push('');
          out.push('```json');
          out.push(safeJson(ev.output ?? null));
          out.push('```');
          out.push('');
          out.push('</details>');
          out.push('');
        }
        break;
      }
      case 'engine_meta': {
        const engine = typeof ev.engine === 'string' ? ev.engine : 'unknown';
        const itemType = typeof ev.itemType === 'string' ? ev.itemType : 'unknown';
        const label = resolveEngineMetaLabel(engine, itemType);
        const summary = summariseEngineMeta(engine, itemType, ev.payload);
        const headLine = `_◌ ${engine.replace('-cli', '')} · ${label}${
          summary ? ` · ${summary}` : ''
        }_`;
        const todoItems =
          engine === 'codex-cli' && itemType === 'todo_list'
            ? extractTodoListItems(ev.payload)
            : null;
        if (todoItems && todoItems.length > 0) {
          out.push(headLine);
          out.push('');
          for (const it of todoItems) {
            const glyph = STATUS_GLYPH[it.status] ?? '○';
            out.push(`- ${glyph} ${it.content}`);
          }
          out.push('');
        } else {
          out.push(`<details><summary>${headLine}</summary>`);
          out.push('');
          out.push('```json');
          out.push(safeJson(ev.payload ?? null));
          out.push('```');
          out.push('');
          out.push('</details>');
          out.push('');
        }
        break;
      }
      case 'turn_end':
      case 'turn_start':
      case 'assistant_audio':
      case 'project_switched':
        // Skipped — these are bookkeeping events; users don't want to
        // see them in a transcript export. They're still in the JSON
        // export for full fidelity.
        break;
      case 'error': {
        out.push(`> ⚠ engine error · ${escapeMd(ev.text ?? '')}`);
        out.push('');
        break;
      }
      default:
        // Unknown event kind — surface so future additions don't
        // silently drop from exports.
        out.push(`_(unrecognised event: ${ev.kind ?? '?'})_`);
        out.push('');
        break;
    }
  }
  return out.join('\n');
}

function escapeMd(s: string): string {
  return s.replace(/[\\`]/g, (m) => `\\${m}`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
