// Team window — the editor for ~/.somora/team.yaml (design:
// private/team-design.md, Phase 2). Left: the org chart as a tree of
// agent cards (drag a card onto another card or onto the principal to
// change who it reports to). Right: the form for the selected node.
// Bottom: the exact "# Your team" block one agent would see, rendered
// server-side from the UNSAVED draft. Nothing here touches the file
// itself: Save → PUT /team, the server validates, writes atomically and
// keeps backups. Thin-client rule, same as the Abilities window.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Eye, GripVertical, Plus, RefreshCw, Save, Undo2, UserMinus, UserPlus } from 'lucide-react';
import {
  api,
  type AgentInfo,
  type TeamAgentDto,
  type TeamFileDto,
  type TeamIssueDto,
  type TeamResponse,
} from '../lib/api';

type Selected = 'principal' | string | null;

// ── pure helpers (exported for the render smoke) ──────────────────────

/** Names in a stable pre-order walk: parent before children, file order among siblings. */
export function chartOrder(agents: Record<string, TeamAgentDto>): Array<{ name: string; depth: number }> {
  const names = Object.keys(agents);
  const out: Array<{ name: string; depth: number }> = [];
  const walk = (parent: string, depth: number, seen: Set<string>): void => {
    for (const n of names) {
      if (agents[n]!.reports_to !== parent || seen.has(n)) continue;
      seen.add(n);
      out.push({ name: n, depth });
      walk(n, depth + 1, seen);
    }
  };
  walk('principal', 0, new Set());
  // Orphans (unknown reports_to) still get a row so they can be fixed.
  for (const n of names) if (!out.some((o) => o.name === n)) out.push({ name: n, depth: 0 });
  return out;
}

/** True when `candidate` is `name` itself or sits somewhere below it. */
export function isSelfOrDescendant(agents: Record<string, TeamAgentDto>, name: string, candidate: string): boolean {
  let cur: string | undefined = candidate;
  const seen = new Set<string>();
  while (cur && cur !== 'principal' && !seen.has(cur)) {
    if (cur === name) return true;
    seen.add(cur);
    cur = agents[cur]?.reports_to;
  }
  return false;
}

/** Move `name` under `parent` ('principal' or an agent). Refuses cycles. */
export function reparent(file: TeamFileDto, name: string, parent: string): TeamFileDto | null {
  if (!file.agents[name]) return null;
  if (parent !== 'principal' && (!file.agents[parent] || isSelfOrDescendant(file.agents, name, parent))) return null;
  return { ...file, agents: { ...file.agents, [name]: { ...file.agents[name]!, reports_to: parent } } };
}

/** Drop `name` from the chart; its reports move up to its parent. */
export function removeFromChart(file: TeamFileDto, name: string): TeamFileDto {
  const parent = file.agents[name]?.reports_to ?? 'principal';
  const agents: Record<string, TeamAgentDto> = {};
  for (const [n, a] of Object.entries(file.agents)) {
    if (n === name) continue;
    agents[n] = a.reports_to === name ? { ...a, reports_to: parent } : a;
  }
  return { ...file, agents };
}

const clone = (f: TeamFileDto): TeamFileDto => JSON.parse(JSON.stringify(f)) as TeamFileDto;

// ── small building blocks ─────────────────────────────────────────────

const mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };
const label: React.CSSProperties = { ...mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-2)', marginBottom: 4 };
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--bg-1)', color: 'var(--text-0)',
  border: '1px solid var(--bg-3)', borderRadius: 6, padding: '6px 8px', fontSize: 13,
};
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, fontSize: 12,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  background: primary ? 'var(--accent)' : 'var(--bg-2)', color: primary ? 'var(--bg-0)' : 'var(--text-1)',
  border: `1px solid ${primary ? 'var(--accent)' : 'var(--bg-3)'}`,
});

function Field({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={label}>{title}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

/** Phrase list as chips + an input. Enter / comma adds, ✕ removes,
 *  Backspace on an empty input removes the last chip. */
function Chips({ values, onChange, placeholder, testId }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; testId: string }) {
  const [text, setText] = useState('');
  const commit = () => {
    const t = text.trim().replace(/,+$/, '').trim();
    if (t) onChange([...values, t]);
    setText('');
  };
  return (
    <div
      data-testid={testId}
      style={{ ...input, display: 'flex', flexWrap: 'wrap', gap: 6, padding: 6, cursor: 'text' }}
    >
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--bg-3)', borderRadius: 999, padding: '2px 8px', fontSize: 12 }}
        >
          {v}
          <button
            type="button"
            aria-label={`remove ${v}`}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            style={{ background: 'none', border: 0, color: 'var(--text-2)', cursor: 'pointer', padding: 0, lineHeight: 1 }}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        value={text}
        placeholder={values.length === 0 ? placeholder : ''}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
          else if (e.key === 'Backspace' && text === '' && values.length > 0) onChange(values.slice(0, -1));
        }}
        onBlur={commit}
        style={{ flex: 1, minWidth: 120, background: 'transparent', border: 0, outline: 'none', color: 'var(--text-0)', fontSize: 13 }}
      />
    </div>
  );
}

// ── the window ────────────────────────────────────────────────────────

export function TeamWindow() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [server, setServer] = useState<TeamResponse | null>(null);
  const [draft, setDraft] = useState<TeamFileDto | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [selected, setSelected] = useState<Selected>('principal');
  const [previewAgent, setPreviewAgent] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ block: string; chars: number; softMax: number; issues: TeamIssueDto[]; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveIssues, setSaveIssues] = useState<TeamIssueDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Drag state lives in a ref: drop handlers read it directly, so they
  // never depend on a re-render landing between dragstart and drop.
  const draggingRef = useRef<string | null>(null);
  const setDragging = (v: string | null) => { draggingRef.current = v; };
  const [initName, setInitName] = useState('');
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = draft !== null && JSON.stringify(draft) !== saved;
  const agentByName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);

  const load = useCallback(async () => {
    try {
      const [t, a] = await Promise.all([api.teamGet(), api.agents()]);
      setServer(t);
      setAgents(a);
      if (t.file) {
        const f = clone(t.file);
        setDraft(f);
        setSaved(JSON.stringify(f));
        setPreviewAgent((p) => p ?? Object.keys(f.agents)[0] ?? null);
      } else {
        setDraft(null);
        setSaved('');
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Live preview of the DRAFT — debounced, server-rendered.
  useEffect(() => {
    if (!draft || !previewAgent) { setPreview(null); return; }
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      void api.teamPreview(draft, previewAgent).then((r) =>
        setPreview({ block: r.block, chars: r.chars ?? r.block.length, softMax: r.softMaxChars ?? 3000, issues: r.issues ?? [], warnings: r.warnings ?? [] }),
      ).catch((err: Error) => setError(err.message));
    }, 350);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [draft, previewAgent]);

  const update = (fn: (f: TeamFileDto) => TeamFileDto) => setDraft((d) => (d ? fn(d) : d));
  const updateAgent = (name: string, patch: Partial<TeamAgentDto>) =>
    update((f) => ({ ...f, agents: { ...f.agents, [name]: { ...f.agents[name]!, ...patch } } }));

  const save = async () => {
    if (!draft) return;
    setBusy(true); setSaveIssues([]); setNotice(null);
    try {
      const r = await api.teamSave(draft);
      setServer(r);
      if (r.file) { const f = clone(r.file); setDraft(f); setSaved(JSON.stringify(f)); }
      setNotice(`Saved${r.backup ? ' — previous version kept as a backup' : ''}. Agents see it on their next turn.`);
    } catch (err) {
      const e = err as Error & { issues?: TeamIssueDto[] };
      if (e.issues && e.issues.length > 0) setSaveIssues(e.issues); else setError(e.message);
    } finally { setBusy(false); }
  };

  const discard = () => { if (server?.file) { const f = clone(server.file); setDraft(f); setSaved(JSON.stringify(f)); } setSaveIssues([]); };

  const init = async () => {
    setBusy(true);
    try { await api.teamInit(initName.trim() || undefined); await load(); setSelected('principal'); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const onDrop = (target: string) => {
    const from = draggingRef.current;
    if (!from) return;
    setDraft((d) => (d ? (reparent(d, from, target) ?? d) : d));
    setDragging(null);
  };

  // ── empty / broken states ───────────────────────────────────────────
  if (error && !server) return <div style={{ padding: 16, color: 'var(--danger)' }}><AlertTriangle size={14} style={{ verticalAlign: -2 }} /> {error}</div>;
  if (!server) return <div style={{ padding: 16, color: 'var(--text-2)' }}>Loading…</div>;
  if (!server.exists) {
    return (
      <div style={{ padding: 20, maxWidth: 520, color: 'var(--text-1)' }} data-testid="team-empty">
        <h3 style={{ margin: '0 0 8px' }}>No team yet</h3>
        <p style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
          A team file tells every agent who is who, who reports to whom and who to involve for what — rendered into each
          agent's prompt from its own seat. Start with all {agents.length} agents reporting to you, then arrange them here.
        </p>
        <Field title="Your name (the principal)">
          <input style={input} value={initName} placeholder="e.g. Ada" onChange={(e) => setInitName(e.target.value)} />
        </Field>
        <button type="button" style={btn(true, busy)} disabled={busy} onClick={() => void init()} data-testid="team-init">
          <Plus size={14} /> Create team.yaml from {agents.length} agents
        </button>
        <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 14 }}>Same as <code>somora team init</code> in a terminal. The file lives at <code>{server.path}</code>.</p>
      </div>
    );
  }
  if (!draft) {
    return (
      <div style={{ padding: 20, color: 'var(--text-1)' }} data-testid="team-invalid">
        <h3 style={{ margin: '0 0 8px', color: 'var(--danger)' }}>team.yaml is invalid</h3>
        <p style={{ color: 'var(--text-2)' }}>The server keeps the last valid team in force. Fix the file by hand ({server.path}) — the problems:</p>
        <ul>{server.issues.map((i, k) => <li key={k}><code>{i.path}</code>: {i.message}</li>)}</ul>
        <button type="button" style={btn()} onClick={() => void load()}><RefreshCw size={14} /> Reload</button>
      </div>
    );
  }

  // ── editor ──────────────────────────────────────────────────────────
  const order = chartOrder(draft.agents);
  const unlisted = agents.filter((a) => !draft.agents[a.name]);
  const sel = selected && selected !== 'principal' && draft.agents[selected] ? selected : selected === 'principal' ? 'principal' : null;
  const selAgent = sel && sel !== 'principal' ? draft.agents[sel]! : null;

  const card = (name: string, depth: number) => {
    const a = draft.agents[name]!;
    const info = agentByName.get(name);
    const inactive = a.active === false;
    const isSel = sel === name;
    return (
      <div
        key={name}
        data-testid={`team-card-${name}`}
        draggable
        onDragStart={() => setDragging(name)}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => { const from = draggingRef.current; if (from && from !== name && !isSelfOrDescendant(draft.agents, from, name)) e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); onDrop(name); }}
        onClick={() => { setSelected(name); setPreviewAgent(name); }}
        style={{
          marginLeft: 14 + depth * 22, marginBottom: 6, padding: '6px 8px', borderRadius: 8, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8, opacity: inactive ? 0.5 : 1,
          background: isSel ? 'var(--bg-3)' : 'var(--bg-2)',
          border: `1px solid ${isSel ? (info?.color ?? 'var(--accent)') : 'var(--bg-3)'}`,
          borderLeft: `3px solid ${info?.color ?? 'var(--bg-3)'}`,
        }}
      >
        <GripVertical size={12} style={{ color: 'var(--text-3)' }} />
        <span style={{ fontSize: 16 }}>{info?.icon ?? '🤖'}</span>
        <span style={{ fontWeight: 600, color: 'var(--text-0)' }}>{name}</span>
        <span style={{ color: 'var(--text-2)', fontSize: 12 }}>{a.title ?? info?.role ?? ''}</span>
        {inactive && <span style={{ ...mono, fontSize: 10, color: 'var(--warn)', marginLeft: 'auto' }}>INACTIVE</span>}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="team-window">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--bg-3)' }}>
        <span style={{ ...mono, fontSize: 11, color: 'var(--text-3)' }}>{server.path}</span>
        <span style={{ flex: 1 }} />
        {dirty && <span style={{ fontSize: 12, color: 'var(--warn)' }}>unsaved changes</span>}
        {!dirty && notice && <span style={{ fontSize: 12, color: 'var(--ok)' }}><Check size={12} style={{ verticalAlign: -2 }} /> {notice}</span>}
        <button type="button" style={btn(false, !dirty || busy)} disabled={!dirty || busy} onClick={discard} title="Discard unsaved changes"><Undo2 size={13} /> Discard</button>
        <button type="button" style={btn(false, busy)} disabled={busy} onClick={() => void load()} title="Reload from disk"><RefreshCw size={13} /></button>
        <button type="button" data-testid="team-save" style={btn(true, !dirty || busy)} disabled={!dirty || busy} onClick={() => void save()}><Save size={13} /> Save</button>
      </div>

      {(error || saveIssues.length > 0 || (server.warnings?.length ?? 0) > 0) && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--bg-3)', fontSize: 12 }}>
          {error && <div style={{ color: 'var(--danger)' }}><AlertTriangle size={12} style={{ verticalAlign: -2 }} /> {error}</div>}
          {saveIssues.map((i, k) => <div key={k} style={{ color: 'var(--danger)' }} data-testid="team-issue">not saved — <code>{i.path}</code>: {i.message}</div>)}
          {server.warnings?.map((w, k) => <div key={k} style={{ color: 'var(--warn)' }}>{w}</div>)}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Chart */}
        <div style={{ width: 320, flexShrink: 0, borderRight: '1px solid var(--bg-3)', padding: 10, overflowY: 'auto' }}>
          <div style={{ ...label, marginBottom: 0 }}>Org chart</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>Drag a card onto its new superior — or onto you.</div>
          <div
            data-testid="team-card-principal"
            onDragOver={(e) => { if (draggingRef.current) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); onDrop('principal'); }}
            onClick={() => setSelected('principal')}
            style={{
              padding: '8px 10px', borderRadius: 8, marginBottom: 8, cursor: 'pointer',
              background: sel === 'principal' ? 'var(--bg-3)' : 'var(--bg-2)',
              border: `1px solid ${sel === 'principal' ? 'var(--accent)' : 'var(--bg-3)'}`,
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>👤 {draft.principal.name || 'Principal'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{draft.principal.title ?? 'Principal'} · human</div>
          </div>
          {order.map((o) => card(o.name, o.depth))}
          {unlisted.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={label}>Not in the chart</div>
              {unlisted.map((a) => (
                <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', color: 'var(--text-2)', fontSize: 13 }}>
                  <span>{a.icon ?? '🤖'}</span><span>{a.name}</span><span style={{ fontSize: 11 }}>{a.role ?? ''}</span>
                  <button
                    type="button" data-testid={`team-add-${a.name}`} style={{ ...btn(), marginLeft: 'auto', padding: '2px 8px' }}
                    onClick={() => { update((f) => ({ ...f, agents: { ...f.agents, [a.name]: { reports_to: 'principal', ...(a.role ? { title: a.role } : {}) } } })); setSelected(a.name); setPreviewAgent(a.name); }}
                  >
                    <UserPlus size={12} /> add
                  </button>
                </div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Until added, colleagues see these under "Not in the org chart yet".</div>
            </div>
          )}
        </div>

        {/* Form */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 12, overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {sel === 'principal' && (
              <div data-testid="team-form-principal">
                <Field title="Name" hint="How the agents should refer to you.">
                  <input style={input} value={draft.principal.name} onChange={(e) => update((f) => ({ ...f, principal: { ...f.principal, name: e.target.value } }))} />
                </Field>
                <Field title="Title">
                  <input style={input} value={draft.principal.title ?? ''} placeholder="Principal" onChange={(e) => update((f) => ({ ...f, principal: { ...f.principal, ...(e.target.value ? { title: e.target.value } : { title: undefined }) } }))} />
                </Field>
                <Field title="About" hint="One to three sentences. Personal detail stays in the agents' USER.md.">
                  <textarea style={{ ...input, minHeight: 64 }} value={draft.principal.about ?? ''} onChange={(e) => update((f) => ({ ...f, principal: { ...f.principal, ...(e.target.value ? { about: e.target.value } : { about: undefined }) } }))} />
                </Field>
                <Field title="Rules — one per line" hint="Rendered verbatim at the end of every agent's block. Empty = somora's four defaults.">
                  <textarea
                    style={{ ...input, minHeight: 110 }}
                    value={(draft.rules ?? []).join('\n')}
                    onChange={(e) => { const lines = e.target.value.split('\n'); update((f) => ({ ...f, rules: lines })); }}
                    onBlur={() => update((f) => { const r = (f.rules ?? []).map((l) => l.trim()).filter(Boolean); return r.length > 0 ? { ...f, rules: r } : { ...f, rules: undefined }; })}
                  />
                </Field>
              </div>
            )}
            {selAgent && sel && sel !== 'principal' && (
              <div data-testid={`team-form-${sel}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 22 }}>{agentByName.get(sel)?.icon ?? '🤖'}</span>
                  <div>
                    <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>{sel}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{agentByName.get(sel)?.description}</div>
                  </div>
                  <span style={{ flex: 1 }} />
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-1)', cursor: 'pointer' }} title="Off = temporarily out of the team: stays in the chart greyed out, colleagues are told not to involve it">
                    <input type="checkbox" data-testid="team-active" checked={selAgent.active !== false} onChange={(e) => updateAgent(sel, e.target.checked ? { active: undefined } : { active: false })} />
                    active
                  </label>
                  <button type="button" style={btn()} title="Remove from the chart (the agent itself stays)" onClick={() => { update((f) => removeFromChart(f, sel)); setSelected('principal'); }}>
                    <UserMinus size={12} /> remove
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field title="Title" hint={`Default: "${agentByName.get(sel)?.role ?? agentByName.get(sel)?.description ?? sel}" from AGENTS.md`}>
                    <input style={input} value={selAgent.title ?? ''} placeholder={agentByName.get(sel)?.role ?? ''} onChange={(e) => updateAgent(sel, { title: e.target.value || undefined })} />
                  </Field>
                  <Field title="Reports to">
                    <select data-testid="team-reports-to" style={input} value={selAgent.reports_to} onChange={(e) => update((f) => reparent(f, sel, e.target.value) ?? f)}>
                      <option value="principal">{draft.principal.name || 'Principal'} (principal)</option>
                      {Object.keys(draft.agents).filter((n) => n !== sel && !isSelfOrDescendant(draft.agents, sel, n)).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </Field>
                </div>
                <Field title="Involve for" hint="Short trigger phrases — what colleagues bring here. Enter adds a phrase.">
                  <Chips testId="team-involve" values={selAgent.involve_for ?? []} placeholder="e.g. library docs, framework comparisons" onChange={(v) => updateAgent(sel, { involve_for: v.length ? v : undefined })} />
                </Field>
                <Field title="Not for" hint="What NOT to bring here.">
                  <Chips testId="team-notfor" values={selAgent.not_for ?? []} placeholder="e.g. media, finance" onChange={(v) => updateAgent(sel, { not_for: v.length ? v : undefined })} />
                </Field>
                <Field title="Notes" hint="Optional nuance, rendered after the phrases (max 600 characters).">
                  <textarea style={{ ...input, minHeight: 56 }} maxLength={600} value={selAgent.notes ?? ''} onChange={(e) => updateAgent(sel, { notes: e.target.value || undefined })} />
                </Field>
              </div>
            )}
            {!sel && <div style={{ color: 'var(--text-2)' }}>Select a card on the left.</div>}
          </div>

          {/* Preview */}
          <div style={{ borderTop: '1px solid var(--bg-3)', flex: '0 0 46%', minHeight: 280, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px' }}>
              <Eye size={13} style={{ color: 'var(--text-2)' }} />
              <span style={{ ...label, marginBottom: 0 }}>Preview — what</span>
              <select data-testid="team-preview-agent" value={previewAgent ?? ''} onChange={(e) => setPreviewAgent(e.target.value)} style={{ ...input, width: 'auto', padding: '2px 6px', fontSize: 12 }}>
                {[...Object.keys(draft.agents), ...unlisted.map((a) => a.name)].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span style={{ ...label, marginBottom: 0 }}>sees{dirty ? ' (draft)' : ''}</span>
              <span style={{ flex: 1 }} />
              {preview && (
                <span style={{ ...mono, fontSize: 11, color: preview.chars > preview.softMax ? 'var(--warn)' : 'var(--text-3)' }}>
                  {preview.chars} / {preview.softMax} chars
                </span>
              )}
            </div>
            <pre data-testid="team-preview" style={{ ...mono, margin: 0, padding: '0 12px 12px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-1)', overflow: 'auto', flex: 1, whiteSpace: 'pre-wrap' }}>
              {preview
                ? preview.issues.length > 0
                  ? preview.issues.map((i) => `✗ ${i.path}: ${i.message}`).join('\n')
                  : preview.block
                : '…'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
