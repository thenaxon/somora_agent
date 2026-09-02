// Slash-command popup: shows above the textarea when the input
// starts with `/`. Two phases:
//
//   1. Command picker — `/`, `/m`, `/se` etc. Lists matching commands
//      from the catalog below.
//   2. Argument picker — once a command is fully typed plus a space
//      (e.g. `/model `), shows live-fetched suggestions for that arg
//      (model refs from /models, session slugs from /agents/<a>/sessions).
//
// Keyboard: ArrowUp/ArrowDown navigate, Enter/Tab accept, Escape
// dismiss. Click also accepts. The component does NOT execute the
// command — it just hands back the picked value via onAccept; the
// parent (ChatWindow) parses on send and dispatches to the right
// handler.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ModelOption, type ProjectInfo, type SessionSummary } from '../lib/api';
import {
  SAMPLING_KEYS,
  SAMPLING_KEY_HINTS,
  SAMPLING_USAGE,
  TEMP_USAGE,
  formatSamplingParams,
  parseSamplingArgs,
  parseSamplingValue,
  type SamplingPatch,
} from '../lib/sampling';
import { useChatContext } from './ChatProvider';

export type SlashCommand =
  | { kind: 'model'; ref: string }
  | { kind: 'session'; slug: string }
  | { kind: 'new'; slug: string }
  | { kind: 'thinking'; level: 'off' | 'low' | 'medium' | 'high' | 'default' }
  // Sampling: `set` PUTs a merge-patch (null removes a key), `clear`
  // DELETEs the whole override, `show` only reports the effective params.
  | { kind: 'sampling'; params: SamplingPatch }
  | { kind: 'sampling-clear' }
  | { kind: 'sampling-show' }
  | { kind: 'reset' }
  | { kind: 'projekt'; slug: string }
  | { kind: 'projekt-unlink' };

interface CommandSpec {
  name: string;
  usage: string;
  hint: string;
}

const COMMANDS: CommandSpec[] = [
  { name: '/model', usage: '/model <ref>', hint: 'switch model for this session' },
  { name: '/session', usage: '/session <slug>', hint: 'switch to another session of this agent' },
  { name: '/new', usage: '/new <slug>', hint: 'create a new session and switch to it' },
  { name: '/thinking', usage: '/thinking <level>', hint: 'off | low | medium | high | default' },
  {
    name: '/sampling',
    usage: '/sampling [key=value …|default]',
    hint: 'temperature, top_p, top_k, … for this session (openai-compatible engine only)',
  },
  { name: '/temp', usage: '/temp <0–2>|default', hint: 'shorthand for /sampling temperature=<n>' },
  { name: '/projekt', usage: '/projekt <slug>', hint: 'pin a project to this session (or "unlink" to clear)' },
  { name: '/project', usage: '/project <slug>', hint: 'alias of /projekt' },
  {
    name: '/reset',
    usage: '/reset YES',
    hint: 'archive this session, force REM dream — type YES to confirm',
  },
];

interface Props {
  agent: string;
  /** Current draft text. Component decides visibility itself based on
   *  whether the draft starts with `/`. */
  draft: string;
  /** Bumped by the parent each time the textarea fires a keydown that
   *  should advance the popup (ArrowUp / ArrowDown / Enter / Tab /
   *  Escape). The popup reads `keyEvent` as a one-shot trigger and
   *  acts on it — the textarea's onKeyDown sets the event, the popup
   *  consumes it via the prop change. */
  keyEvent: { key: string; nonce: number } | null;
  /** Called when the user accepts a row. Parent should replace the
   *  draft text with the returned `commit` string (which may end in
   *  a space if the picker expects more input) — and then either
   *  re-trigger suggestions for the next phase or, when `done=true`,
   *  dispatch the resolved command and clear. */
  onAccept: (out: { commit: string; resolved?: SlashCommand }) => void;
  /** Called when Escape is pressed or the user types something that
   *  invalidates the popup (no matches at all). Parent typically just
   *  hides the popup and lets the textarea go back to plain typing. */
  onDismiss: () => void;
}

interface PickerRow {
  /** Text to insert into the draft when accepted. */
  commit: string;
  /** Display label. */
  label: string;
  /** Secondary line under the label, optional. */
  detail?: string;
  /** When set, accepting this row resolves a runnable command. */
  resolved?: SlashCommand;
}

export function SlashCommandPopup({
  agent,
  draft,
  keyEvent,
  onAccept,
  onDismiss,
}: Props) {
  const { projectsEnabled } = useChatContext();
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const lastConsumedNonce = useRef<number | null>(null);

  // Filter project commands out of the menu entirely when the feature
  // is disabled (or still loading at boot). Keeps the slash surface
  // clean for users who don't run projects.
  const visibleCommands = useMemo(
    () =>
      COMMANDS.filter(
        (c) => projectsEnabled || (c.name !== '/projekt' && c.name !== '/project'),
      ),
    [projectsEnabled],
  );

  // Lazy-load arg-picker data only when first needed. Cached for the
  // popup's lifetime (closing + reopening the popup re-mounts and
  // refetches — fine, lists are small).
  useEffect(() => {
    if (draft.startsWith('/model ') && models === null) {
      api.models().then(setModels).catch(() => setModels([]));
    }
  }, [draft, models]);
  useEffect(() => {
    if (draft.startsWith('/session ') && sessions === null) {
      api.sessions(agent).then(setSessions).catch(() => setSessions([]));
    }
  }, [draft, agent, sessions]);
  useEffect(() => {
    const wantsProjects =
      draft.startsWith('/projekt ') || draft.startsWith('/project ');
    if (wantsProjects && projects === null) {
      api.projects().then(setProjects).catch(() => setProjects([]));
    }
  }, [draft, projects]);

  // Compute current rows based on what phase the draft is in.
  const rows: PickerRow[] = useMemo(() => {
    const trimmed = draft.trimStart();
    if (!trimmed.startsWith('/')) return [];

    // Phase 1: command picker — no space yet, or just the slash.
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) {
      const prefix = trimmed.toLowerCase();
      return visibleCommands.filter((c) => c.name.startsWith(prefix)).map((c) => ({
        commit: `${c.name} `,
        label: c.usage,
        detail: c.hint,
      }));
    }

    // Phase 2: arg picker — split command + arg-prefix.
    const cmd = trimmed.slice(0, firstSpace).toLowerCase();
    const argPrefix = trimmed.slice(firstSpace + 1);

    if (cmd === '/model') {
      if (!models) return [{ commit: draft, label: 'loading models…' }];
      const lower = argPrefix.toLowerCase();
      return models
        .filter(
          (m) =>
            m.ref.toLowerCase().includes(lower) ||
            (m.alias && m.alias.toLowerCase().includes(lower)) ||
            m.id.toLowerCase().includes(lower),
        )
        .map((m) => ({
          commit: `/model ${m.ref}`,
          label: m.ref,
          detail: `${m.engine} · ctx ${formatContext(m.contextWindow)} · ${m.capabilities.join(',')}`,
          resolved: { kind: 'model', ref: m.ref } as SlashCommand,
        }));
    }

    if (cmd === '/session') {
      if (!sessions) return [{ commit: draft, label: 'loading sessions…' }];
      const lower = argPrefix.toLowerCase();
      return sessions
        .filter((s) => s.slug.toLowerCase().includes(lower))
        .map((s) => ({
          commit: `/session ${s.slug}`,
          label: s.slug,
          detail: `${s.messageCount} msgs · last ${formatRelative(s.lastActivity)}`,
          resolved: { kind: 'session', slug: s.slug } as SlashCommand,
        }));
    }

    if (cmd === '/new') {
      // Free-form slug — only one row that confirms whatever the user
      // typed. No fetch. Slug must be non-empty + not 'main'.
      const slug = argPrefix.trim();
      if (!slug) {
        return [{ commit: draft, label: 'type a slug — e.g. /new debug-session' }];
      }
      if (slug === 'main') {
        return [{ commit: draft, label: '"main" is reserved — pick another slug' }];
      }
      return [
        {
          commit: `/new ${slug}`,
          label: `create session "${slug}"`,
          detail: 'POST /agents/.../sessions, then switch this window to it',
          resolved: { kind: 'new', slug } as SlashCommand,
        },
      ];
    }

    if (cmd === '/reset') {
      // Two-step confirmation: bare `/reset` shows a non-resolving
      // warning row; only `/reset YES` resolves to an actual reset.
      // Mirrors the TUI's `/reset [YES]` semantics — destructive
      // commands shouldn't fire on a single Enter.
      const arg = argPrefix.trim();
      if (arg !== 'YES') {
        return [
          {
            commit: '/reset YES',
            label: 'type "YES" to confirm reset',
            detail: 'archives current session jsonl + forces REM dream over the just-closed range',
          },
        ];
      }
      return [
        {
          commit: '/reset YES',
          label: 'reset session NOW',
          detail: 'session jsonl moves to <session>-archive, REM dream spawns over it',
          resolved: { kind: 'reset' } as SlashCommand,
        },
      ];
    }

    if (cmd === '/thinking') {
      const levels: Array<'off' | 'low' | 'medium' | 'high' | 'default'> = [
        'off',
        'low',
        'medium',
        'high',
        'default',
      ];
      const lower = argPrefix.toLowerCase();
      return levels
        .filter((l) => l.startsWith(lower))
        .map((l) => ({
          commit: `/thinking ${l}`,
          label: l,
          detail:
            l === 'default'
              ? 'inherit from persona / engine default'
              : l === 'off'
                ? 'disable thinking'
                : `effort: ${l}`,
          resolved: { kind: 'thinking', level: l } as SlashCommand,
        }));
    }

    if (cmd === '/sampling') {
      // Three phases, all client-side (no fetch):
      //   `/sampling `            → show-current row + key completions + default
      //   `/sampling temp`        → key completions filtered by prefix
      //   `/sampling temperature=1 [top_p=…]` → one confirm row that
      //                             resolves to a PUT, or a usage row
      //                             when a pair doesn't parse.
      // Free-form like `/new`: the popup never executes, it hands the
      // parsed patch to ChatWindow.dispatchSlash.
      const arg = argPrefix.replace(/^\s+/, '');
      const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
      const trailingSpace = /\s$/.test(arg);
      const last = trailingSpace ? '' : (tokens[tokens.length - 1] ?? '');
      const head = trailingSpace ? tokens : tokens.slice(0, -1);
      const headText = head.length ? `${head.join(' ')} ` : '';
      const out: PickerRow[] = [];

      if (tokens.length === 0) {
        out.push({
          commit: '/sampling',
          label: 'show current sampling params',
          detail: 'effective values + where they come from',
          resolved: { kind: 'sampling-show' } as SlashCommand,
        });
      }
      if (head.length === 0 && (last === '' || 'default'.startsWith(last.toLowerCase()) || last === '-')) {
        out.push({
          commit: '/sampling default',
          label: 'default',
          detail: 'clear the session override, fall back to persona / model default',
          resolved: { kind: 'sampling-clear' } as SlashCommand,
        });
      }
      if (last.includes('=')) {
        // Completed (or in-progress) pair: validate everything typed so far.
        const parsed = parseSamplingArgs(tokens);
        if (parsed.ok) {
          out.push({
            commit: `/sampling ${tokens.join(' ')}`,
            label: `set ${formatSamplingParams(parsed.params)}`,
            detail: 'merges into the session override · "-" removes a key',
            resolved: { kind: 'sampling', params: parsed.params } as SlashCommand,
          });
        } else {
          out.push({ commit: draft, label: parsed.error, detail: SAMPLING_USAGE });
        }
        return out;
      }
      // Key completions — commit ends in `=` so the user types the value next.
      const lower = last.toLowerCase();
      for (const key of SAMPLING_KEYS) {
        if (!key.startsWith(lower)) continue;
        out.push({
          commit: `/sampling ${headText}${key}=`,
          label: `${key}=`,
          detail: SAMPLING_KEY_HINTS[key],
        });
      }
      if (head.length > 0 && last === '') {
        // `/sampling temperature=1 ` — pairs so far are complete; offer
        // to send them as-is above the next-key completions.
        const parsed = parseSamplingArgs(head);
        out.unshift(
          parsed.ok
            ? {
                commit: `/sampling ${head.join(' ')}`,
                label: `set ${formatSamplingParams(parsed.params)}`,
                detail: 'merges into the session override · "-" removes a key',
                resolved: { kind: 'sampling', params: parsed.params } as SlashCommand,
              }
            : { commit: draft, label: parsed.error, detail: SAMPLING_USAGE },
        );
      }
      if (out.length === 0) out.push({ commit: draft, label: `unknown key "${last}"`, detail: SAMPLING_USAGE });
      return out;
    }

    if (cmd === '/temp') {
      const arg = argPrefix.trim();
      const presets: Array<{ v: string; hint: string }> = [
        { v: '0.2', hint: 'focused · near-deterministic' },
        { v: '0.7', hint: 'balanced' },
        { v: '1.0', hint: 'model default · creative' },
      ];
      const lower = arg.toLowerCase();
      const out: PickerRow[] = [];
      for (const p of presets) {
        if (!p.v.startsWith(lower)) continue;
        out.push({
          commit: `/temp ${p.v}`,
          label: p.v,
          detail: p.hint,
          resolved: { kind: 'sampling', params: { temperature: Number(p.v) } } as SlashCommand,
        });
      }
      if (!arg || 'default'.startsWith(lower) || arg === '-') {
        out.push({
          commit: '/temp default',
          label: 'default',
          detail: 'remove only the temperature override (other sampling keys stay)',
          resolved: { kind: 'sampling', params: { temperature: null } } as SlashCommand,
        });
      }
      if (arg && !presets.some((p) => p.v === arg) && arg !== 'default' && arg !== '-') {
        const v = parseSamplingValue('temperature', arg);
        out.unshift(
          v.ok
            ? {
                commit: `/temp ${arg}`,
                label: `temperature=${arg}`,
                detail: 'PUT { temperature } into the session override',
                resolved: { kind: 'sampling', params: { temperature: v.value as number } } as SlashCommand,
              }
            : { commit: draft, label: v.error, detail: TEMP_USAGE },
        );
      }
      return out;
    }

    if (cmd === '/projekt' || cmd === '/project') {
      if (!projectsEnabled) {
        // Defensive — if a user types /projekt directly even though
        // the autocomplete hides it, return nothing so the popup
        // dismisses cleanly instead of fetching a 503'd endpoint.
        return [];
      }
      // First row is always the unlink action so it's reachable even
      // before the projects list has loaded — common case when the
      // user knows they want to clear the pin.
      const out: PickerRow[] = [];
      const arg = argPrefix.trim().toLowerCase();
      if (
        !arg ||
        'unlink'.startsWith(arg) ||
        'off'.startsWith(arg) ||
        'clear'.startsWith(arg) ||
        arg === '-'
      ) {
        out.push({
          commit: `${cmd} unlink`,
          label: 'unlink — clear pinned project for this session',
          resolved: { kind: 'projekt-unlink' } as SlashCommand,
        });
      }
      if (!projects) {
        out.push({ commit: draft, label: 'loading projects…' });
        return out;
      }
      for (const p of projects) {
        const matches =
          !arg ||
          p.slug.toLowerCase().includes(arg) ||
          p.name.toLowerCase().includes(arg) ||
          p.entity.toLowerCase().includes(arg);
        if (!matches) continue;
        out.push({
          commit: `${cmd} ${p.slug}`,
          label: p.name,
          detail: `${p.entity}${p.tags.length ? ` · ${p.tags.join(', ')}` : ''} · ${p.paths.length} path${p.paths.length === 1 ? '' : 's'}`,
          resolved: { kind: 'projekt', slug: p.slug } as SlashCommand,
        });
      }
      return out;
    }

    // Unknown command — show nothing and let the parent dismiss.
    return [];
  }, [draft, models, sessions, projects, projectsEnabled, visibleCommands]);

  // Reset highlight when the row list shrinks/grows so we never point
  // past the end.
  useEffect(() => {
    setActiveIdx((i) => (rows.length === 0 ? 0 : Math.min(i, rows.length - 1)));
  }, [rows.length]);

  // Consume parent's keyboard signal one nonce at a time.
  useEffect(() => {
    if (!keyEvent) return;
    if (keyEvent.nonce === lastConsumedNonce.current) return;
    lastConsumedNonce.current = keyEvent.nonce;
    if (keyEvent.key === 'ArrowDown') {
      setActiveIdx((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
    } else if (keyEvent.key === 'ArrowUp') {
      setActiveIdx((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
    } else if (keyEvent.key === 'Enter' || keyEvent.key === 'Tab') {
      const row = rows[activeIdx];
      if (row && row.commit !== draft) {
        onAccept({ commit: row.commit, ...(row.resolved ? { resolved: row.resolved } : {}) });
      } else if (row?.resolved) {
        onAccept({ commit: row.commit, resolved: row.resolved });
      }
    } else if (keyEvent.key === 'Escape') {
      onDismiss();
    }
  }, [keyEvent, rows, activeIdx, draft, onAccept, onDismiss]);

  if (rows.length === 0) return null;

  return (
    <div
      className="slash-popup"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 8,
        right: 8,
        marginBottom: 4,
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        maxHeight: 240,
        overflowY: 'auto',
        zIndex: 10,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 12,
      }}
    >
      {rows.map((r, i) => (
        <div
          key={`${r.commit}-${i}`}
          onMouseDown={(e) => {
            // Prevent textarea blur — mousedown fires before click and
            // before our onAccept gets to focus things back.
            e.preventDefault();
            if (r.commit === draft && !r.resolved) return;
            onAccept({ commit: r.commit, ...(r.resolved ? { resolved: r.resolved } : {}) });
          }}
          onMouseEnter={() => setActiveIdx(i)}
          style={{
            padding: '6px 10px',
            cursor: r.resolved || r.commit !== draft ? 'pointer' : 'default',
            background: i === activeIdx ? 'var(--bg-3)' : 'transparent',
            borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--line-2)',
          }}
        >
          <div style={{ color: 'var(--text-1)' }}>{r.label}</div>
          {r.detail && (
            <div style={{ color: 'var(--text-3)', fontSize: 10, marginTop: 2 }}>{r.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!ts) return '?';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
