// Agent window — what a persona is made of, and what it costs.
//
// Opened from the agent tile's context menu ("Configure…"). Top: a
// budget strip (persona total, team block, full assembled prompt, tool
// schemas) against config.promptBudgets. Tabs: AGENTS.md / SOUL.md /
// USER.md as plain editors with a per-file counter, agent.yaml read-
// only, and "Full prompt" — the system prompt exactly as the next turn
// on a session would send it, split into parts. Saves go through
// PUT /agents/:agent/persona/:file with the hash the file had when it
// was loaded: the agents self-edit these files, so a stale save is
// refused (409) instead of overwriting what the agent wrote.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Eye, FileText, Lock, RefreshCw, Save, Undo2 } from 'lucide-react';
import { api, type PersonaResponse, type PromptPreviewResponse, type SessionSummary } from '../lib/api';

type Tab = 'AGENTS.md' | 'SOUL.md' | 'USER.md' | 'agent.yaml' | 'prompt';

const mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };
const label: React.CSSProperties = { ...mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-2)' };
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, fontSize: 12,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  background: primary ? 'var(--accent)' : 'var(--bg-2)', color: primary ? 'var(--bg-0)' : 'var(--text-1)',
  border: `1px solid ${primary ? 'var(--accent)' : 'var(--bg-3)'}`,
});

/** chars/4 — a rough token estimate, honest enough for a budget strip. */
export const estTokens = (chars: number): number => Math.round(chars / 4);
export const fmt = (n: number): string => n.toLocaleString('en-US');

/** Budget meter: value against a soft cap, warn colour when over. */
export function Meter({ title, value, cap, hint, testId }: { title: string; value: number; cap?: number; hint?: string; testId?: string }) {
  const over = cap !== undefined && value > cap;
  const pct = cap ? Math.min(100, Math.round((value / cap) * 100)) : 0;
  return (
    <div data-testid={testId} style={{ minWidth: 150, flex: 1 }}>
      <div style={{ ...label, marginBottom: 2 }}>{title}</div>
      <div style={{ ...mono, fontSize: 13, color: over ? 'var(--warn)' : 'var(--text-0)' }}>
        {fmt(value)}{cap !== undefined ? ` / ${fmt(cap)}` : ''} <span style={{ color: 'var(--text-3)', fontSize: 11 }}>chars · ≈{fmt(estTokens(value))} tok</span>
      </div>
      {cap !== undefined && (
        <div style={{ height: 3, background: 'var(--bg-3)', borderRadius: 2, marginTop: 4 }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: over ? 'var(--warn)' : 'var(--accent)' }} />
        </div>
      )}
      {hint && <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

export function AgentConfigWindow({ agentName }: { agentName: string }) {
  const [data, setData] = useState<PersonaResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('AGENTS.md');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ file: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [previewSession, setPreviewSession] = useState('main');
  const [preview, setPreview] = useState<PromptPreviewResponse | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.persona(agentName);
      setData(r);
      setDrafts(Object.fromEntries(r.files.map((f) => [f.name, f.content])));
      setConflict(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agentName]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void api.sessions(agentName).then(setSessions).catch(() => setSessions([])); }, [agentName]);

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await api.promptPreview(agentName, previewSession));
      setPreviewErr(null);
    } catch (err) {
      setPreviewErr((err as Error).message);
    }
  }, [agentName, previewSession]);
  useEffect(() => { void loadPreview(); }, [loadPreview]);

  const fileByName = useMemo(() => new Map<string, PersonaResponse['files'][number]>((data?.files ?? []).map((f) => [f.name, f])), [data]);
  const isDirty = (name: string) => fileByName.has(name) && drafts[name] !== fileByName.get(name)!.content;
  const editable = (['AGENTS.md', 'SOUL.md', 'USER.md'] as const);
  const personaDraftChars = editable.reduce((n, f) => n + (drafts[f]?.length ?? 0), 0);

  const save = async (name: string) => {
    const f = fileByName.get(name);
    if (!f) return;
    setBusy(true); setNotice(null); setError(null); setConflict(null);
    try {
      const r = await api.personaSave(agentName, name, drafts[name] ?? '', f.hash);
      setNotice(`${name} saved${r.backup ? ' — previous version kept as a backup' : ''}. The agent uses it on its next turn.`);
      await load();
      void loadPreview();
    } catch (err) {
      const e = err as Error & { status?: number; currentContent?: string };
      if (e.status === 409) setConflict({ file: name, content: e.currentContent ?? '' });
      else setError(e.message);
    } finally { setBusy(false); }
  };

  if (error && !data) return <div style={{ padding: 16, color: 'var(--danger)' }}><AlertTriangle size={14} className="icon-inline" /> {error}</div>;
  if (!data) return <div style={{ padding: 16, color: 'var(--text-2)' }}>Loading…</div>;

  const b = data.budgets;
  const teamPart = preview?.parts.find((p) => p.key === 'team');
  const tabs: Array<{ id: Tab; title: string; icon: React.ReactNode }> = [
    ...editable.map((f) => ({ id: f as Tab, title: f, icon: <FileText size={12} /> })),
    { id: 'agent.yaml', title: 'agent.yaml', icon: <Lock size={12} /> },
    { id: 'prompt', title: 'Full prompt', icon: <Eye size={12} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="agent-config-window">
      {/* Budget strip */}
      <div style={{ display: 'flex', gap: 18, padding: '10px 14px', borderBottom: '1px solid var(--bg-3)', flexWrap: 'wrap' }}>
        <Meter testId="meter-persona" title="Persona (3 files)" value={personaDraftChars} cap={b.personaTotalChars} hint="AGENTS + SOUL + USER, as drafted here" />
        <Meter testId="meter-team" title="Team block" value={teamPart?.chars ?? 0} cap={b.teamBlockChars} hint="from team.yaml" />
        <Meter testId="meter-prompt" title="Full prompt" value={preview?.chars ?? 0} hint={`everything somora sends as instructions · session ${previewSession}`} />
        <Meter testId="meter-tools" title={`Tool schemas (${preview?.tools.count ?? 0})`} value={preview?.tools.schemaChars ?? 0} hint="API tool channel, not in the prompt text" />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: '1px solid var(--bg-3)' }}>
        {tabs.map((t) => {
          const f = fileByName.get(t.id);
          const over = f && !f.readOnly && (drafts[t.id]?.length ?? 0) > b.personaFileChars;
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`agent-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              style={{
                ...btn(false), padding: '4px 10px',
                background: tab === t.id ? 'var(--bg-3)' : 'transparent', borderColor: tab === t.id ? 'var(--bg-3)' : 'transparent',
                color: over ? 'var(--warn)' : tab === t.id ? 'var(--text-0)' : 'var(--text-2)',
              }}
            >
              {t.icon} {t.title}{isDirty(t.id) ? ' •' : ''}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        {notice && <span style={{ fontSize: 12, color: 'var(--ok)' }}><Check size={12} className="icon-inline" /> {notice}</span>}
        <button type="button" style={btn(false, busy)} disabled={busy} onClick={() => { void load(); void loadPreview(); }} title="Reload from disk"><RefreshCw size={13} /></button>
      </div>

      {(error || conflict) && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--bg-3)', fontSize: 12, color: 'var(--danger)' }} data-testid="agent-conflict">
          <AlertTriangle size={12} className="icon-inline" />{' '}
          {conflict
            ? <>{conflict.file} changed on disk since you loaded it — the agent may have edited it. Your text was NOT saved.{' '}
                <button type="button" style={{ ...btn(), padding: '2px 8px' }} onClick={() => void load()}>Reload</button>{' '}
                (your draft stays in the editor until you reload)</>
            : error}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab !== 'prompt' && (() => {
          const f = fileByName.get(tab);
          if (!f) return null;
          const draft = drafts[tab] ?? '';
          const over = !f.readOnly && draft.length > b.personaFileChars;
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px' }}>
                <span style={{ ...mono, fontSize: 11, color: over ? 'var(--warn)' : 'var(--text-3)' }} data-testid="agent-file-count">
                  {fmt(draft.length)}{f.readOnly ? '' : ` / ${fmt(b.personaFileChars)}`} chars · ≈{fmt(estTokens(draft.length))} tok
                  {over ? ' — over the per-file budget (promptBudgets.personaFileChars)' : ''}
                </span>
                {!f.exists && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>(file does not exist yet — saving creates it)</span>}
                <span style={{ flex: 1 }} />
                {f.readOnly ? (
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}><Lock size={11} className="icon-inline" /> operator config — model, fallback, REM. Read-only here; edit the file or use the session model/thinking controls.</span>
                ) : (
                  <>
                    <button type="button" style={btn(false, !isDirty(tab) || busy)} disabled={!isDirty(tab) || busy} onClick={() => setDrafts((d) => ({ ...d, [tab]: f.content }))}><Undo2 size={12} /> Discard</button>
                    <button type="button" data-testid="agent-save" style={btn(true, !isDirty(tab) || busy)} disabled={!isDirty(tab) || busy} onClick={() => void save(tab)}><Save size={12} /> Save {tab}</button>
                  </>
                )}
              </div>
              <textarea
                data-testid="agent-editor"
                value={draft}
                readOnly={f.readOnly}
                spellCheck={false}
                onChange={(e) => setDrafts((d) => ({ ...d, [tab]: e.target.value }))}
                style={{
                  ...mono, flex: 1, minHeight: 0, resize: 'none', margin: '0 12px 12px', padding: 10, fontSize: 12.5, lineHeight: 1.5,
                  background: 'var(--bg-1)', color: f.readOnly ? 'var(--text-2)' : 'var(--text-0)',
                  border: `1px solid ${over ? 'var(--warn)' : 'var(--bg-3)'}`, borderRadius: 6, outline: 'none',
                }}
              />
            </>
          );
        })()}

        {tab === 'prompt' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} data-testid="agent-prompt-tab">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', flexWrap: 'wrap' }}>
              <span style={label}>as the next turn on</span>
              <select value={previewSession} onChange={(e) => setPreviewSession(e.target.value)} style={{ ...mono, fontSize: 12, background: 'var(--bg-1)', color: 'var(--text-0)', border: '1px solid var(--bg-3)', borderRadius: 6, padding: '2px 6px' }}>
                {[{ id: 'main', slug: 'main' }, ...sessions.filter((s) => !s.isMain)].map((s) => <option key={s.id} value={s.id}>{s.slug}</option>)}
              </select>
              <span style={label}>would send it</span>
              <span style={{ flex: 1 }} />
              {preview && <span style={{ ...mono, fontSize: 11, color: 'var(--text-3)' }}>{fmt(preview.chars)} chars · ≈{fmt(estTokens(preview.chars))} tokens</span>}
            </div>
            {previewErr && <div style={{ padding: '0 12px', color: 'var(--danger)', fontSize: 12 }}>{previewErr}</div>}
            {preview && (
              <div style={{ display: 'flex', gap: 12, padding: '0 12px 8px', flexWrap: 'wrap' }}>
                <table style={{ ...mono, fontSize: 11, borderCollapse: 'collapse', color: 'var(--text-1)' }} data-testid="agent-prompt-parts">
                  <tbody>
                    {preview.parts.map((p) => (
                      <tr key={p.key}>
                        <td style={{ padding: '1px 10px 1px 0', color: 'var(--text-2)' }}>{p.label}</td>
                        <td style={{ padding: '1px 8px', textAlign: 'right' }}>{fmt(p.chars)}</td>
                        <td style={{ padding: '1px 8px', textAlign: 'right', color: 'var(--text-3)' }}>≈{fmt(estTokens(p.chars))} tok</td>
                        <td style={{ padding: '1px 8px', textAlign: 'right', color: 'var(--text-3)' }}>{preview.chars ? Math.round((p.chars / preview.chars) * 100) : 0} %</td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: '1px solid var(--bg-3)' }}>
                      <td style={{ padding: '3px 10px 1px 0', color: 'var(--text-2)' }}>+ tool schemas ({preview.tools.count} tools, API tool channel)</td>
                      <td style={{ padding: '3px 8px 1px', textAlign: 'right' }}>{fmt(preview.tools.schemaChars)}</td>
                      <td style={{ padding: '3px 8px 1px', textAlign: 'right', color: 'var(--text-3)' }}>≈{fmt(estTokens(preview.tools.schemaChars))} tok</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
                <div style={{ fontSize: 11, color: 'var(--text-3)', maxWidth: 360, lineHeight: 1.45 }}>
                  Not in this text: {preview.notIncluded.join('; ')}. Token counts are chars ÷ 4 — an estimate.
                </div>
              </div>
            )}
            <pre data-testid="agent-prompt-text" style={{ ...mono, margin: '0 12px 12px', padding: 10, fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-1)', background: 'var(--bg-1)', border: '1px solid var(--bg-3)', borderRadius: 6, overflow: 'auto', flex: 1, whiteSpace: 'pre-wrap' }}>
              {preview?.text ?? '…'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

