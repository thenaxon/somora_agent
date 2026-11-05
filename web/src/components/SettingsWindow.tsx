// The settings window (docs/web.md "Settings window"): config.yaml as
// a form, sorted like a system settings app. A sidebar of groups with a
// search, a pane of boxes per section with one row per setting — its
// name, a control, one plain sentence and, on request, more. Changes
// collect at the bottom until Apply; the server writes only the lines
// that changed, keeps a backup and reloads. Keys never reach the
// browser: a secret shows as set or not set and can only be replaced.
//
// What each setting is called and what it does comes from the server's
// catalog (src/config/settings/catalog); limits and defaults from the
// schema. A group whose texts are not written yet shows its values read
// only.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlarmClock, Bot, Brain, ChevronDown, ChevronRight, Code2, Cpu, History, Image, LayoutGrid, Lock, Mic, Monitor, RotateCcw, Search, Settings, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import { api, type SettingChange, type SettingFieldInfo, type SettingsView } from '../lib/api';

type Pending = Map<string, { value: unknown } | { reset: true } | { secret: string }>;
type View = { kind: 'overview' } | { kind: 'group'; id: string } | { kind: 'yaml' } | { kind: 'backups' };

const ADVANCED_KEY = 'somora.web.settings.advanced';

function readAdvanced(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(ADVANCED_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function getAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** "historyWeightShort" → "History weight short" (a setting without its text yet). */
export function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isSecret(v: unknown): v is { secret: true; set: boolean } {
  return !!v && typeof v === 'object' && (v as { secret?: unknown }).secret === true;
}

/** "memory.md#automatic-recall" → the page on docs.somora.ai. */
export function docsUrl(ref: string): string {
  const [page, anchor] = ref.split('#');
  return `https://docs.somora.ai/${page!.replace(/\.md$/, '')}${anchor ? `#${anchor}` : ''}`;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** The group icons the server names (catalog/index.ts). */
const ICONS: Record<string, LucideIcon> = { AlarmClock, Bot, Brain, Cpu, Image, LayoutGrid, Mic, Monitor, Settings, Sparkles, Wrench };

function Icon({ name, size = 15 }: { name: string; size?: number }) {
  const C = ICONS[name] ?? Settings;
  return <C size={size} />;
}

export function SettingsWindow() {
  const [data, setData] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending>(new Map());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState<Record<string, boolean>>(readAdvanced);
  const [highlight, setHighlight] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.settings());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggleAdvanced = (groupId: string) => {
    setAdvanced((a) => {
      const next = { ...a, [groupId]: !a[groupId] };
      try {
        localStorage.setItem(ADVANCED_KEY, JSON.stringify(next));
      } catch {
        /* private window */
      }
      return next;
    });
  };

  const change = (path: string, c: { value: unknown } | { reset: true } | { secret: string } | null) => {
    setPending((p) => {
      const next = new Map(p);
      if (c === null) next.delete(path);
      else next.set(path, c);
      return next;
    });
    setFieldErrors((e) => {
      if (!e[path]) return e;
      const { [path]: _drop, ...rest } = e;
      return rest;
    });
  };

  const apply = async () => {
    if (!data || pending.size === 0) return;
    setBusy(true);
    setResult(null);
    const changes: SettingChange[] = [...pending.entries()].map(([path, c]) => ({ path, ...c }) as SettingChange);
    let r: Awaited<ReturnType<typeof api.applySettings>>;
    try {
      r = await api.applySettings(data.hash, changes);
    } catch (err) {
      // The connection dropped: the changes stay here to apply again.
      setResult({ tone: 'error', text: `Not applied — the server did not answer (${(err as Error).message}). Your changes are kept.` });
      return;
    } finally {
      setBusy(false);
    }
    if (r.conflict) {
      setResult({ tone: 'error', text: 'config.yaml changed since this window read it. Your changes are kept here — press Reload, check them, then Apply again.' });
      return;
    }
    if (!r.ok) {
      const errs: Record<string, string> = {};
      for (const i of r.issues ?? []) errs[i.path] = i.message;
      setFieldErrors(errs);
      setResult({ tone: 'error', text: `${r.error ?? 'Not applied'}${r.issues?.length ? ` — ${r.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}` : ''}` });
      return;
    }
    if (r.unchanged) {
      setPending(new Map());
      setResult({ tone: 'ok', text: 'Nothing to change — config.yaml already has these values.' });
      return;
    }
    const restart = (r.reload?.ok ? (r.reload.restartRequired ?? []) : []).map((sec) => data.fields.find((f) => f.path === sec)?.info?.label ?? sec);
    setPending(new Map());
    setFieldErrors({});
    setResult(
      !r.reload?.ok
        ? { tone: 'warn', text: `Saved, but the reload failed: ${r.reload?.error ?? 'unknown error'}` }
        : restart.length > 0
          ? { tone: 'warn', text: `Saved. ${restart.join(', ')} ${restart.length === 1 ? 'applies' : 'apply'} after a restart — use Restart server in the gear menu.` }
          : { tone: 'ok', text: 'Saved and applied.' },
    );
    await load();
  };

  const fieldsBySection = useMemo(() => {
    const m = new Map<string, SettingFieldInfo[]>();
    for (const f of data?.fields ?? []) m.set(f.section, [...(m.get(f.section) ?? []), f]);
    return m;
  }, [data]);

  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    return data.fields.filter((f) => f.kind !== 'object' && !f.path.includes('*') && `${f.info?.label ?? ''} ${f.info?.help ?? ''} ${f.path}`.toLowerCase().includes(q)).slice(0, 60);
  }, [query, data]);

  if (error) return <div className="settings-empty">Could not read the settings: {error}</div>;
  if (!data) return <div className="settings-empty">reading config.yaml…</div>;

  const group = view.kind === 'group' ? data.groups.find((g) => g.id === view.id) : undefined;
  const changedFromDefault = (sections: string[]) => data.inFile.filter((p) => sections.includes(p.split('.')[0]!) && p.includes('.')).length;

  return (
    <div className="settings-window">
      <nav className="settings-side">
        <label className="settings-search">
          <Search size={13} />
          <input value={query} placeholder="Search" onChange={(e) => setQuery(e.target.value)} aria-label="Search settings" />
        </label>
        <button type="button" className={`settings-nav ${view.kind === 'overview' && !query ? 'on' : ''}`} onClick={() => { setQuery(''); setView({ kind: 'overview' }); }}>
          <Icon name="LayoutGrid" /> Overview
        </button>
        <div className="settings-nav-sep" />
        {data.groups.map((g) => {
          const dirty = [...pending.keys()].some((p) => g.sections.includes(p.split('.')[0]!));
          return (
            <button key={g.id} type="button" className={`settings-nav ${group?.id === g.id && !query ? 'on' : ''}`} onClick={() => { setQuery(''); setView({ kind: 'group', id: g.id }); }}>
              <Icon name={g.icon} /> <span className="settings-nav-text">{g.title}</span>
              {dirty && <span className="settings-dot" aria-label="changed" />}
              {!g.ready && <span className="settings-soon" title="Read only for now: change these in config.yaml"><Lock size={11} /></span>}
            </button>
          );
        })}
        <div className="settings-nav-grow" />
        <button type="button" className={`settings-nav ${view.kind === 'yaml' ? 'on' : ''}`} onClick={() => { setQuery(''); setView({ kind: 'yaml' }); }}>
          <Code2 size={15} /> View as YAML
        </button>
        <button type="button" className={`settings-nav ${view.kind === 'backups' ? 'on' : ''}`} onClick={() => { setQuery(''); setView({ kind: 'backups' }); }}>
          <History size={15} /> Earlier versions
        </button>
      </nav>

      <main className="settings-main">
        {!data.valid && (
          <div className="settings-banner error">
            config.yaml does not validate right now — the last valid version keeps running. {data.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')}
          </div>
        )}
        {query.trim() ? (
          <SearchResults
            hits={searchHits}
            groups={data.groups}
            onOpen={(f) => {
              const g = data.groups.find((x) => x.sections.includes(f.section));
              if (g) {
                setQuery('');
                setView({ kind: 'group', id: g.id });
                if (f.info?.level === 'advanced' && !advanced[g.id]) toggleAdvanced(g.id);
                setHighlight(f.path);
                setTimeout(() => document.getElementById(`setting-${f.path}`)?.scrollIntoView({ block: 'center' }), 50);
              }
            }}
          />
        ) : view.kind === 'overview' ? (
          <div className="settings-pane">
            <h2>Overview</h2>
            <p className="settings-lead">
              Everything here is stored in <code>{data.path}</code>. Only the lines you change are written; your comments and layout stay, and every change keeps a backup.
            </p>
            <div className="settings-tiles">
              {data.groups.map((g) => (
                <button key={g.id} type="button" className="settings-tile" onClick={() => setView({ kind: 'group', id: g.id })}>
                  <span className="settings-tile-icon"><Icon name={g.icon} size={18} /></span>
                  <span className="settings-tile-title">{g.title}</span>
                  <span className="settings-tile-sub">
                    {changedFromDefault(g.sections)} set in config.yaml{g.ready ? '' : ' · read only for now'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : view.kind === 'yaml' ? (
          <YamlView />
        ) : view.kind === 'backups' ? (
          <BackupsView hash={data.hash} onRestored={(text) => { setResult({ tone: 'ok', text }); void load(); setPending(new Map()); }} />
        ) : group ? (
          <div className="settings-pane">
            <h2><Icon name={group.icon} size={18} /> {group.title}</h2>
            {!group.ready && <div className="settings-banner">This group is read only for now — change these settings in config.yaml.</div>}
            {group.sections.map((section) => (
              <SectionBoxes
                key={section}
                section={section}
                fields={fieldsBySection.get(section) ?? []}
                data={data}
                pending={pending}
                errors={fieldErrors}
                readOnly={!group.ready}
                showAdvanced={!!advanced[group.id]}
                highlight={highlight}
                onChange={change}
              />
            ))}
            {group.ready && (
              <button type="button" className="settings-advanced" onClick={() => toggleAdvanced(group.id)}>
                {advanced[group.id] ? 'Hide advanced options' : 'Show advanced options'}
              </button>
            )}
          </div>
        ) : null}

        <footer className="settings-foot">
          {result && <span className={`settings-result ${result.tone}`}>{result.text}</span>}
          <span className="settings-foot-grow" />
          {pending.size > 0 && <span className="settings-count">{pending.size} change{pending.size === 1 ? '' : 's'}</span>}
          <button type="button" className="settings-btn" disabled={busy} onClick={() => { void load(); setResult(null); }}>Reload</button>
          <button type="button" className="settings-btn" disabled={busy || pending.size === 0} onClick={() => { setPending(new Map()); setFieldErrors({}); setResult(null); }}>Discard</button>
          <button type="button" className="settings-btn primary" disabled={busy || pending.size === 0} onClick={() => void apply()}>{busy ? 'Applying…' : 'Apply'}</button>
        </footer>
      </main>
    </div>
  );
}

function SearchResults({ hits, groups, onOpen }: { hits: SettingFieldInfo[]; groups: SettingsView['groups']; onOpen: (f: SettingFieldInfo) => void }) {
  if (hits.length === 0) return <div className="settings-pane"><p className="settings-lead">No setting matches.</p></div>;
  return (
    <div className="settings-pane">
      <h2>Search</h2>
      <div className="settings-box">
        {hits.map((f) => (
          <button key={f.path} type="button" className="settings-hit" onClick={() => onOpen(f)}>
            <span className="settings-hit-label">{f.info?.label ?? humanize(f.path.split('.').pop()!)}</span>
            <span className="settings-hit-where">{groups.find((g) => g.sections.includes(f.section))?.title} · <code>{f.path}</code></span>
            {f.info?.help && <span className="settings-help">{f.info.help}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

interface BoxProps {
  section: string;
  fields: SettingFieldInfo[];
  data: SettingsView;
  pending: Pending;
  errors: Record<string, string>;
  readOnly: boolean;
  showAdvanced: boolean;
  highlight: string | null;
  onChange: (path: string, c: { value: unknown } | { reset: true } | { secret: string } | null) => void;
}

/** One box per block of the section: the section itself, then every
 *  nested block with its own settings. Lists and named entries get an
 *  editor of their own inside their parent's box. */
function SectionBoxes(p: BoxProps) {
  const restart = p.data.restartSections.includes(p.section);
  const blocks = p.fields.filter((f) => f.kind === 'object' && !f.path.includes('*') && f.path !== p.section);
  // Boxes with everyday settings first, like a settings app puts what
  // most people change at the top; the order within each kind stays.
  const hasBasic = (block: string) => p.fields.some((f) => !f.path.includes('*') && f.path.slice(0, f.path.lastIndexOf('.')) === block && f.info?.level === 'basic');
  const allBlocks = [p.section, ...blocks.map((b) => b.path)];
  const blockPaths = [...allBlocks.filter(hasBasic), ...allBlocks.filter((b) => !hasBasic(b))];
  const childrenOf = (block: string) =>
    p.fields.filter((f) => {
      if (f.path.includes('*')) return false;
      const parent = f.path.slice(0, f.path.lastIndexOf('.'));
      return parent === block && f.kind !== 'object';
    });
  const visible = (f: SettingFieldInfo) => p.readOnly || p.showAdvanced || (f.info?.level ?? 'advanced') === 'basic';
  return (
    <>
      {blockPaths.map((block) => {
        const kids = childrenOf(block).filter(visible);
        if (kids.length === 0) return null;
        const head = p.fields.find((f) => f.path === block);
        const title = head?.info?.label ?? humanize(block.split('.').pop()!);
        return (
          <section key={block} className="settings-box">
            <header className="settings-box-head">
              <span>{title}</span>
              <span className={`settings-badge ${restart ? 'restart' : 'live'}`}>{restart ? 'needs restart' : 'live'}</span>
            </header>
            {head?.info?.help && <p className="settings-box-help">{head.info.help}</p>}
            {kids.map((f) => (
              <SettingRow key={f.path} field={f} {...p} entryFields={p.fields.filter((x) => x.path.startsWith(`${f.path}.*.`))} />
            ))}
          </section>
        );
      })}
    </>
  );
}

function SettingRow(p: BoxProps & { field: SettingFieldInfo; entryFields: SettingFieldInfo[] }) {
  const { field: f } = p;
  const [more, setMore] = useState(false);
  const pend = p.pending.get(f.path);
  const current = getAt(p.data.values, f.path);
  const inFile = p.data.inFile.includes(f.path);
  const shown = pend && 'value' in pend ? pend.value : pend && 'reset' in pend ? f.default : current;
  const label = f.info?.label ?? humanize(f.path.split('.').pop()!);
  const disabled = p.readOnly;
  const set = (v: unknown) => {
    if (JSON.stringify(v) === JSON.stringify(current) && inFile) p.onChange(f.path, null);
    else p.onChange(f.path, { value: v });
  };
  const err = p.errors[f.path];
  return (
    <div id={`setting-${f.path}`} className={`settings-row ${pend ? 'changed' : ''} ${p.highlight === f.path ? 'hl' : ''}`}>
      <div className="settings-row-main">
        <label className="settings-label" htmlFor={`in-${f.path}`}>
          {label}
          {f.info?.level === 'advanced' && <span className="settings-adv">advanced</span>}
        </label>
        <div className="settings-control">
          {isSecret(current) || f.info?.sensitive ? (
            <SecretControl id={`in-${f.path}`} set={isSecret(current) ? current.set : false} pending={pend && 'secret' in pend} disabled={disabled} onSecret={(s) => p.onChange(f.path, s === null ? null : { secret: s })} />
          ) : (
            <Control id={`in-${f.path}`} field={f} value={shown} disabled={disabled} onChange={set} entryFields={p.entryFields} />
          )}
          {!disabled && (pend ? (
            <button type="button" className="settings-icon-btn" title="Undo this change" onClick={() => p.onChange(f.path, null)}><RotateCcw size={12} /></button>
          ) : inFile && f.default !== undefined ? (
            <button type="button" className="settings-icon-btn" title={`Back to the default (${JSON.stringify(f.default)})`} onClick={() => p.onChange(f.path, { reset: true })}>↺</button>
          ) : (
            <span className="settings-default" title="Not in config.yaml: the default applies">{inFile ? '' : 'default'}</span>
          ))}
        </div>
      </div>
      {f.info?.help && <p className="settings-help">{f.info.help}</p>}
      {pend && 'reset' in pend && <p className="settings-help">Goes back to the default: the line is removed from config.yaml.</p>}
      {f.info?.unit === 'bytes' && typeof shown === 'number' && <p className="settings-help">= {formatBytes(shown)}</p>}
      {err && <p className="settings-error">{err}</p>}
      {(f.info?.more || f.info?.docs) && (
        <button type="button" className="settings-more" onClick={() => setMore((m) => !m)}>
          {more ? <ChevronDown size={11} /> : <ChevronRight size={11} />} more
        </button>
      )}
      {more && (
        <div className="settings-more-text">
          {f.info?.more && <p>{f.info.more}</p>}
          <p className="settings-path"><code>{f.path}</code>{f.info?.docs && <> · <a href={docsUrl(f.info.docs)} target="_blank" rel="noreferrer">Read in the docs</a></>}</p>
        </div>
      )}
    </div>
  );
}

function SecretControl({ id, set, pending, disabled, onSecret }: { id: string; set: boolean; pending?: boolean; disabled: boolean; onSecret: (s: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  if (editing) {
    return (
      <span className="settings-secret">
        <input id={id} type="password" autoComplete="new-password" value={text} onChange={(e) => setText(e.target.value)} placeholder="new value" />
        <button type="button" className="settings-btn" disabled={!text} onClick={() => { onSecret(text); setEditing(false); setText(''); }}>Set</button>
        <button type="button" className="settings-btn" onClick={() => { setEditing(false); setText(''); }}>Cancel</button>
      </span>
    );
  }
  return (
    <span className="settings-secret">
      <span className="settings-secret-state">{pending ? 'new value set' : set ? '•••• set' : 'not set'}</span>
      {!disabled && <button type="button" className="settings-btn" onClick={() => setEditing(true)}>Replace…</button>}
      {pending && <button type="button" className="settings-btn" onClick={() => onSecret(null)}>Undo</button>}
    </span>
  );
}

function Control({ id, field: f, value, disabled, onChange, entryFields }: { id: string; field: SettingFieldInfo; value: unknown; disabled: boolean; onChange: (v: unknown) => void; entryFields: SettingFieldInfo[] }) {
  switch (f.kind) {
    case 'boolean':
      return (
        <button id={id} type="button" role="switch" aria-checked={value === true} disabled={disabled} className={`settings-switch ${value === true ? 'on' : ''}`} onClick={() => onChange(!(value === true))}>
          <span />
        </button>
      );
    case 'enum':
      if ((f.enum ?? []).length <= 4) {
        return (
          <span id={id} className="settings-seg" role="radiogroup">
            {(f.enum ?? []).map((e) => (
              <button key={e} type="button" role="radio" aria-checked={value === e} disabled={disabled} className={value === e ? 'on' : ''} onClick={() => onChange(e)}>{e}</button>
            ))}
          </span>
        );
      }
      return (
        <select id={id} className="settings-input" disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          {value === undefined && <option value="">—</option>}
          {(f.enum ?? []).map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      );
    case 'integer':
    case 'number':
      return <NumberControl id={id} field={f} value={value} disabled={disabled} onChange={onChange} />;
    case 'strings':
      return <StringsControl id={id} value={Array.isArray(value) ? (value as unknown[]).map(String) : []} disabled={disabled} onChange={onChange} />;
    case 'one-or-many': {
      const list = Array.isArray(value) ? (value as unknown[]).map(String) : typeof value === 'string' ? [value] : [];
      return <StringsControl id={id} value={list} disabled={disabled} onChange={(v) => onChange((v as string[]).length === 1 ? (v as string[])[0] : v)} />;
    }
    case 'list':
    case 'map':
      return <EntriesControl field={f} value={value} disabled={disabled} onChange={onChange} entryFields={entryFields} />;
    default:
      return <TextControl id={id} value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)} placeholder={f.info?.placeholder} disabled={disabled} onChange={(t) => onChange(t === '' && f.nullable ? null : t)} />;
  }
}

function TextControl({ id, value, placeholder, disabled, onChange }: { id: string; value: string; placeholder?: string; disabled: boolean; onChange: (t: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <input id={id} className="settings-input wide" value={text} placeholder={placeholder} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== value) onChange(text); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

function NumberControl({ id, field: f, value, disabled, onChange }: { id: string; field: SettingFieldInfo; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined || value === null ? '' : String(value));
  const [bad, setBad] = useState<string | null>(null);
  useEffect(() => setText(value === undefined || value === null ? '' : String(value)), [value]);
  const unit = f.info?.unit;
  const slider = f.kind === 'number' && f.min === 0 && f.max === 1;
  const commit = (t: string) => {
    if (t.trim() === '' && f.nullable) {
      setBad(null);
      onChange(null);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) return setBad('a number');
    if (f.kind === 'integer' && !Number.isInteger(n)) return setBad('a whole number');
    if (f.min !== undefined && (f.minExclusive ? n <= f.min : n < f.min)) return setBad(`${f.minExclusive ? 'above' : 'at least'} ${f.min}`);
    if (f.max !== undefined && n > f.max) return setBad(`at most ${f.max}`);
    setBad(null);
    if (n !== value) onChange(n);
  };
  return (
    <span className="settings-number">
      {slider && (
        <input type="range" min={0} max={1} step={0.05} disabled={disabled} value={typeof value === 'number' ? value : 0} onChange={(e) => { setText(e.target.value); commit(e.target.value); }} aria-label="slider" />
      )}
      <input id={id} className={`settings-input num ${bad ? 'bad' : ''}`} inputMode="decimal" disabled={disabled} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => commit(text)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} title={bad ? `Must be ${bad}` : undefined} />
      {unit && <span className="settings-unit">{unit}</span>}
      {bad && <span className="settings-error inline">must be {bad}</span>}
    </span>
  );
}

function StringsControl({ id, value, disabled, onChange }: { id: string; value: string[]; disabled: boolean; onChange: (v: unknown) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (!t || value.includes(t)) return;
    onChange([...value, t]);
    setText('');
  };
  return (
    <span className="settings-chips">
      {value.map((v) => (
        <span key={v} className="settings-chip">
          {v}
          {!disabled && <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>}
        </span>
      ))}
      {!disabled && <input id={id} className="settings-input chip" value={text} placeholder="add…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} onBlur={add} />}
    </span>
  );
}

/** Named entries (a map) or a list of entries: one line per entry, a
 *  click opens its fields; + adds, − removes. The change goes to the
 *  server as the whole list or map. */
function EntriesControl({ field: f, value, disabled, onChange, entryFields }: { field: SettingFieldInfo; value: unknown; disabled: boolean; onChange: (v: unknown) => void; entryFields: SettingFieldInfo[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const isMap = f.kind === 'map';
  const entries: Array<[string, Record<string, unknown>]> = isMap
    ? Object.entries((value ?? {}) as Record<string, Record<string, unknown>>)
    : ((Array.isArray(value) ? value : []) as Array<Record<string, unknown>>).map((v, i) => [String(i), v]);
  const direct = entryFields.filter((x) => x.path.split('.').length === f.path.split('.').length + 2);
  const summary = (e: Record<string, unknown>) => String(e.alias ?? e.id ?? e.name ?? e.label ?? e.slug ?? Object.values(e).find((v) => typeof v === 'string') ?? '');
  const write = (next: Array<[string, Record<string, unknown>]>) => onChange(isMap ? Object.fromEntries(next) : next.map(([, v]) => v));
  const setField = (key: string, name: string, v: unknown) => write(entries.map(([k, e]) => (k === key ? [k, { ...e, [name]: v }] : [k, e])));
  const add = () => {
    const name = isMap ? window.prompt('Name of the new entry') : String(entries.length);
    if (!name || (isMap && entries.some(([k]) => k === name))) return;
    write([...entries, [name, {}]]);
    setOpen(name);
  };
  return (
    <div className="settings-entries">
      {entries.length === 0 && <span className="settings-help">none</span>}
      {entries.map(([k, e]) => (
        <div key={k} className="settings-entry">
          <button type="button" className="settings-entry-head" onClick={() => setOpen(open === k ? null : k)}>
            {open === k ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <span>{isMap ? k : summary(e) || `entry ${Number(k) + 1}`}</span>
            {isMap && summary(e) && <span className="settings-entry-sub">{summary(e)}</span>}
          </button>
          {!disabled && <button type="button" className="settings-icon-btn" title="Remove" onClick={() => write(entries.filter(([x]) => x !== k))}>−</button>}
          {open === k && (
            <div className="settings-entry-body">
              {direct.map((df) => {
                const name = df.path.split('.').pop()!;
                return (
                  <div key={df.path} className="settings-entry-field">
                    <span className="settings-entry-label" title={df.info?.help}>{df.info?.label ?? humanize(name)}{df.required ? ' *' : ''}</span>
                    {df.info?.sensitive ? (
                      <span className="settings-help">{e[name] ? '•••• set' : 'not set'} — keys of entries are changed in config.yaml</span>
                    ) : df.kind === 'object' || df.kind === 'list' || df.kind === 'map' ? (
                      <span className="settings-help">{e[name] === undefined ? 'not set' : 'set'} — change it in config.yaml for now</span>
                    ) : (
                      <Control id={`in-${f.path}-${k}-${name}`} field={df} value={e[name]} disabled={disabled} onChange={(v) => setField(k, name, v)} entryFields={[]} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {!disabled && <button type="button" className="settings-btn" onClick={add}>+ Add</button>}
    </div>
  );
}

function YamlView() {
  const [text, setText] = useState<string | null>(null);
  const [path, setPath] = useState('');
  useEffect(() => {
    void api.settingsYaml().then((r) => { setText(r.text); setPath(r.path); }).catch((e: Error) => setText(`Could not read: ${e.message}`));
  }, []);
  return (
    <div className="settings-pane">
      <h2>View as YAML</h2>
      <p className="settings-lead"><code>{path}</code> as it is on disk, read only. Keys and passwords show as •••• (set).</p>
      <div className="settings-yaml-actions">
        <button type="button" className="settings-btn" disabled={!text} onClick={() => void navigator.clipboard?.writeText(text ?? '')}>Copy</button>
      </div>
      <pre className="settings-yaml">{text ?? 'reading…'}</pre>
    </div>
  );
}

function BackupsView({ hash, onRestored }: { hash: string; onRestored: (text: string) => void }) {
  const [list, setList] = useState<Array<{ name: string; at: number; bytes: number }> | null>(null);
  const [keep, setKeep] = useState(20);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api.settingsBackups().then((r) => { setList(r.backups); setKeep(r.keep); }).catch((e: Error) => setErr(e.message));
  }, []);
  const restore = async (name: string, at: number) => {
    if (!window.confirm(`Go back to the version from ${new Date(at).toLocaleString()}? The current file is kept as a backup too.`)) return;
    const r = await api.restoreSettings(name, hash);
    if (!r.ok) return setErr(r.conflict ? 'config.yaml changed since this window read it — press Reload first.' : (r.error ?? 'not restored'));
    onRestored(r.reload?.ok && (r.reload.restartRequired ?? []).length > 0 ? `Restored. ${r.reload.restartRequired!.join(', ')} applies after a restart — Restart server in the gear menu.` : 'Restored and applied.');
  };
  let body: ReactNode;
  if (err) body = <div className="settings-banner error">{err}</div>;
  else if (!list) body = <p className="settings-lead">reading…</p>;
  else if (list.length === 0) body = <p className="settings-lead">No earlier versions yet. One is kept each time settings are applied here.</p>;
  else
    body = (
      <div className="settings-box">
        {list.map((b) => (
          <div key={b.name} className="settings-row">
            <div className="settings-row-main">
              <span className="settings-label">{new Date(b.at).toLocaleString()}</span>
              <div className="settings-control">
                <span className="settings-help">{formatBytes(b.bytes)}</span>
                <button type="button" className="settings-btn" onClick={() => void restore(b.name, b.at)}>Restore</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  return (
    <div className="settings-pane">
      <h2>Earlier versions</h2>
      <p className="settings-lead">Before every change made here the file is saved; the last {keep} stay.</p>
      {body}
    </div>
  );
}
