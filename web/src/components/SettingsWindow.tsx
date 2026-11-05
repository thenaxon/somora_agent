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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
      // An entry removed takes its pending field changes along.
      if (c && 'reset' in c) for (const k of [...next.keys()]) if (k.startsWith(`${path}.`)) next.delete(k);
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
          ? { tone: 'warn', text: `Saved. Takes effect after a restart: ${restart.join(', ')} — use Restart server in the gear menu.` }
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
    return data.fields.filter((f) => f.kind !== 'object' && (!f.info?.retired || data.inFile.includes(f.path)) && !f.path.includes('*') && `${f.info?.label ?? ''} ${f.info?.help ?? ''} ${f.path}`.toLowerCase().includes(q)).slice(0, 60);
  }, [query, data]);

  if (error) return <div className="settings-empty">Could not read the settings: {error}</div>;
  if (!data) return <div className="settings-empty">reading config.yaml…</div>;

  const group = view.kind === 'group' ? data.groups.find((g) => g.id === view.id) : undefined;
  const changedFromDefault = (sections: string[]) => data.inFile.filter((p) => sections.includes(p.split('.')[0]!) && p.includes('.')).length;

  return (
    <RefOptions.Provider value={data.refOptions ?? {}}>
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
    </RefOptions.Provider>
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
  // A section that is itself a list of entries (`resources`): one box
  // with its entries editor.
  const own = p.fields.find((f) => f.path === p.section);
  if (own && (own.kind === 'map' || own.kind === 'list')) {
    return (
      <section className="settings-box">
        <header className="settings-box-head">
          <span>{own.info?.label ?? humanize(p.section)}</span>
          <span className={`settings-badge ${restart ? 'restart' : 'live'}`}>{restart ? 'needs restart' : 'live'}</span>
        </header>
        <SettingRow field={own} {...p} />
      </section>
    );
  }
  const visible = (f: SettingFieldInfo) =>
    // A retired setting shows only while the file still sets it — then
    // always, advanced or not, so it can be removed.
    f.info?.retired ? p.data.inFile.includes(f.path) : p.readOnly || p.showAdvanced || (f.info?.level ?? 'advanced') === 'basic';
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
              <SettingRow key={f.path} field={f} {...p} />
            ))}
          </section>
        );
      })}
    </>
  );
}

function SettingRow(p: BoxProps & { field: SettingFieldInfo }) {
  const { field: f } = p;
  const [more, setMore] = useState(false);
  const pend = p.pending.get(f.path);
  const current = getAt(p.data.values, f.path);
  const inFile = p.data.inFile.includes(f.path);
  const shown = pend && 'value' in pend ? pend.value : pend && 'reset' in pend ? f.default : current;
  const label = f.info?.label ?? humanize(f.path.split('.').pop()!);
  const envName = p.data.envSet?.[f.path];
  const disabled = p.readOnly || !!f.info?.locked || !!f.info?.retired || !!envName;
  const set = (v: unknown) => {
    if (JSON.stringify(v) === JSON.stringify(current) && inFile) p.onChange(f.path, null);
    else p.onChange(f.path, { value: v });
  };
  const err = p.errors[f.path];
  if (f.kind === 'map' || f.kind === 'list') {
    // Entries: each change is its own path below this one.
    const entryErrors = Object.entries(p.errors).filter(([k]) => k.startsWith(`${f.path}.`));
    return (
      <div id={`setting-${f.path}`} className={`settings-row ${p.highlight === f.path ? 'hl' : ''}`}>
        <div className="settings-row-main">
          <span className="settings-label">{label}{f.info?.level === 'advanced' && <span className="settings-adv">advanced</span>}</span>
        </div>
        {f.info?.help && <p className="settings-help">{f.info.help}</p>}
        <EntriesControl tpl={f.path} at={f.path} value={current} ctx={{ fields: p.data.fields, inFile: new Set(p.data.inFile), pending: p.pending, disabled, change: p.onChange }} />
        {entryErrors.map(([k, m]) => <p key={k} className="settings-error"><code>{k}</code>: {m}</p>)}
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
            <Control id={`in-${f.path}`} field={f} value={shown} disabled={disabled} onChange={set} />
          )}
          {f.info?.retired && !p.readOnly && inFile ? (
            pend ? (
              <button type="button" className="settings-icon-btn" title="Undo this change" onClick={() => p.onChange(f.path, null)}><RotateCcw size={12} /></button>
            ) : (
              <button type="button" className="settings-text-btn" title="No longer read: remove it from config.yaml" onClick={() => p.onChange(f.path, { reset: true })}>Remove</button>
            )
          ) : envName ? (
            <span className="settings-default" title={`Set by ${envName}`}>env</span>
          ) : f.info?.locked ? (
            <span className="settings-default" title={f.info.locked}><Lock size={11} /></span>
          ) : !disabled && (pend ? (
            <button type="button" className="settings-icon-btn" title="Undo this change" onClick={() => p.onChange(f.path, null)}><RotateCcw size={12} /></button>
          ) : inFile && f.default !== undefined ? (
            <button type="button" className="settings-icon-btn" title={`Back to the default (${JSON.stringify(f.default)})`} onClick={() => p.onChange(f.path, { reset: true })}>↺</button>
          ) : (
            <span className="settings-default" title="Not in config.yaml: the default applies">{inFile ? '' : 'default'}</span>
          ))}
        </div>
      </div>
      {f.info?.help && <p className="settings-help">{f.info.help}</p>}
      {envName && <p className="settings-help settings-locked"><Lock size={10} className="icon-inline" /> Set by the environment variable <code>{envName}</code>, which wins over config.yaml; the value shown is the file's.</p>}
      {f.info?.locked && <p className="settings-help settings-locked"><Lock size={10} className="icon-inline" /> {f.info.locked}</p>}
      {pend && 'reset' in pend && <p className="settings-help">{f.info?.retired ? 'The line is removed from config.yaml.' : 'Goes back to the default: the line is removed from config.yaml.'}</p>}
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

/** The names a reference can take (GET /settings refOptions): offered
 *  as suggestions in the text field of a setting that names a model,
 *  a provider or a named model. */
const RefOptions = createContext<Partial<Record<string, string[]>>>({});

function Control({ id, field: f, value, disabled, onChange }: { id: string; field: SettingFieldInfo; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  const refs = useContext(RefOptions);
  const options = f.info?.ref ? refs[f.info.ref] : undefined;
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
      return <StringsControl id={id} value={Array.isArray(value) ? (value as unknown[]).map(String) : []} disabled={disabled} onChange={onChange} options={options} />;
    case 'boolean-or-strings': {
      // All (true), none (false), or only the names listed.
      const mode = Array.isArray(value) ? 'some' : value === false ? 'none' : value === true ? 'all' : '';
      return (
        <span className="settings-chips">
          <span id={id} className="settings-seg" role="radiogroup">
            {(['all', 'none', 'some'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={disabled} className={mode === m ? 'on' : ''} onClick={() => onChange(m === 'all' ? true : m === 'none' ? false : Array.isArray(value) ? value : [])}>
                {m === 'some' ? 'only these' : m}
              </button>
            ))}
          </span>
          {Array.isArray(value) && <StringsControl id={`${id}-list`} value={(value as unknown[]).map(String)} disabled={disabled} onChange={onChange} options={options} />}
        </span>
      );
    }
    case 'one-or-many': {
      const list = Array.isArray(value) ? (value as unknown[]).map(String) : typeof value === 'string' ? [value] : [];
      return <StringsControl id={id} value={list} disabled={disabled} onChange={(v) => onChange((v as string[]).length === 1 ? (v as string[])[0] : v)} options={options} />;
    }
    default:
      return <TextControl id={id} value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)} placeholder={f.info?.placeholder} disabled={disabled} onChange={(t) => onChange(t === '' && f.nullable ? null : t)} options={options} />;
  }
}

function TextControl({ id, value, placeholder, disabled, onChange, options }: { id: string; value: string; placeholder?: string; disabled: boolean; onChange: (t: string) => void; options?: string[] }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const unknown = !!options && text !== '' && !options.includes(text);
  return (
    <>
      <input id={id} className={`settings-input wide ${unknown ? 'unknown-ref' : ''}`} value={text} placeholder={placeholder ?? (options ? 'choose or type…' : undefined)} disabled={disabled} list={options ? `${id}-options` : undefined} title={unknown ? 'Not a name configured here' : undefined} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== value) onChange(text); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {options && <datalist id={`${id}-options`}>{options.map((o) => <option key={o} value={o} />)}</datalist>}
    </>
  );
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

function StringsControl({ id, value, disabled, onChange, options }: { id: string; value: string[]; disabled: boolean; onChange: (v: unknown) => void; options?: string[] }) {
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
      {!disabled && <input id={id} className="settings-input chip" value={text} placeholder="add…" list={options ? `${id}-options` : undefined} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} onBlur={add} />}
      {options && <datalist id={`${id}-options`}>{options.filter((o) => !value.includes(o)).map((o) => <option key={o} value={o} />)}</datalist>}
    </span>
  );
}

/** What an entries editor needs from the window: every field, the
 *  pending changes and the way to record one. Each change is one path:
 *  a field of an entry (`mcp.servers.<name>.url`), a new entry as a
 *  whole (`mcp.servers.<name>`, `imageGen.models.3`), or an entry
 *  removed — so the file keeps everything else, comments included. */
interface EntryCtx {
  fields: SettingFieldInfo[];
  /** Paths the file itself sets (GET /settings inFile). */
  inFile: Set<string>;
  pending: Pending;
  disabled: boolean;
  change: (path: string, c: { value: unknown } | { reset: true } | { secret: string } | null) => void;
}

const fieldAt = (fields: SettingFieldInfo[], tpl: string) => fields.find((x) => x.path === tpl);
const childrenOf = (fields: SettingFieldInfo[], tpl: string) => {
  const depth = tpl.split('.').length + 1;
  return fields.filter((x) => x.path.startsWith(`${tpl}.`) && x.path.split('.').length === depth);
};
const summaryOf = (e: unknown) => {
  if (!e || typeof e !== 'object') return '';
  const o = e as Record<string, unknown>;
  const v = o.alias ?? o.name ?? o.id ?? o.label ?? o.slug ?? o.url ?? o.command ?? o.host;
  return typeof v === 'string' ? v : '';
};

/** An entry name as one path segment: a dot inside it (a model alias
 *  such as `gpt-5.5`) is written `%2E`, and the server reads it back. */
const pathKey = (k: string) => k.replace(/%/g, '%25').replace(/\./g, '%2E');
const keyName = (k: string) => {
  try {
    return decodeURIComponent(k);
  } catch {
    return k;
  }
};

/** Named entries (a map) or a list of entries: one line per entry, a
 *  click opens its fields; + adds, − removes. A map whose entries are
 *  plain values (headers, voices per agent) is a list of name → value. */
function EntriesControl({ tpl, at, value, ctx }: { tpl: string; at: string; value: unknown; ctx: EntryCtx }) {
  const [open, setOpen] = useState<string | null>(null);
  const holder = fieldAt(ctx.fields, tpl);
  const isMap = holder?.kind === 'map';
  const entryTpl = `${tpl}.*`;
  const plain = childrenOf(ctx.fields, entryTpl).length === 0;
  const current: Array<[string, unknown]> = isMap
    ? Object.entries((value && typeof value === 'object' ? value : {}) as Record<string, unknown>).map(([k, v]) => [pathKey(k), v] as [string, unknown])
    : (Array.isArray(value) ? value : []).map((v, i) => [String(i), v]);
  // Keys here are path segments: a name with a dot is written with %2E.
  const known = new Set(current.map(([k]) => k));
  const added: Array<[string, unknown]> = [...ctx.pending]
    .filter(([p, c]) => p.startsWith(`${at}.`) && !p.slice(at.length + 1).includes('.') && 'value' in c && !known.has(p.slice(at.length + 1)))
    .map(([p, c]) => [p.slice(at.length + 1), (c as { value: unknown }).value] as [string, unknown])
    .sort(([a], [b]) => (isMap ? 0 : Number(a) - Number(b)));
  const sensitive = !!holder?.info?.sensitive || /headers$/.test(tpl);
  const add = () => {
    const raw = isMap ? window.prompt(plain ? 'Name of the new entry (for a header: its name)' : 'Name of the new entry')?.trim() : String(current.length + added.length);
    const name = raw ? (isMap ? pathKey(raw) : raw) : '';
    if (!name || known.has(name) || added.some(([k]) => k === name)) return;
    ctx.change(`${at}.${name}`, { value: plain ? '' : {} });
    setOpen(name);
  };
  // Remove an entry of the file (or keep it again), or drop a new one.
  // New entries of a list stay numbered right after the file's own.
  const toggle = (k: string, origin: 'file' | 'new', isRemoved: boolean) => {
    if (origin === 'file') return ctx.change(`${at}.${k}`, isRemoved ? null : { reset: true });
    if (isMap) return ctx.change(`${at}.${k}`, null);
    const rest = added.filter(([x]) => x !== k);
    for (const [x] of added) ctx.change(`${at}.${x}`, null);
    rest.forEach(([, v], i) => ctx.change(`${at}.${current.length + i}`, { value: v }));
  };
  const rows: Array<[string, unknown, 'file' | 'new']> = [...current.map(([k, v]) => [k, v, 'file'] as [string, unknown, 'file']), ...added.map(([k, v]) => [k, v, 'new'] as [string, unknown, 'new'])];
  return (
    <div className="settings-entries">
      {rows.length === 0 && <span className="settings-help">none</span>}
      {rows.map(([k, e, origin]) => {
        const path = `${at}.${k}`;
        const removed = ctx.pending.get(path);
        const isRemoved = !!removed && 'reset' in removed;
        const title = isMap ? keyName(k) : summaryOf(e) || `entry ${Number(k) + 1}`;
        if (plain) {
          return (
            <div key={k} className={`settings-entry plain ${isRemoved ? 'removed' : ''} ${origin === 'new' ? 'added' : ''}`}>
              <span className="settings-entry-name">{keyName(k)}</span>
              {isRemoved ? (
                <span className="settings-help">removed on Apply</span>
              ) : sensitive || isSecret(e) ? (
                <SecretControl id={`in-${path}`} set={isSecret(e) ? e.set : false} pending={ctx.pending.has(path) && origin === 'file'} disabled={ctx.disabled} onSecret={(s) => ctx.change(path, s === null ? (origin === 'new' ? { value: '' } : null) : origin === 'new' ? { value: s } : { secret: s })} />
              ) : (
                <TextControl id={`in-${path}`} value={String((ctx.pending.get(path) as { value?: unknown } | undefined)?.value ?? e ?? '')} disabled={ctx.disabled} onChange={(t) => ctx.change(path, origin === 'file' && t === String(e ?? '') ? null : { value: plainValue(t, holder?.valueKind) })} />
              )}
              {!ctx.disabled && <EntryRemove origin={origin} removed={isRemoved} onToggle={() => toggle(k, origin, isRemoved)} />}
            </div>
          );
        }
        return (
          <div key={k} className={`settings-entry ${isRemoved ? 'removed' : ''} ${origin === 'new' ? 'added' : ''}`}>
            <div className="settings-entry-row">
              <button type="button" className="settings-entry-head" disabled={isRemoved} onClick={() => setOpen(open === k ? null : k)}>
                {open === k && !isRemoved ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>{title}</span>
                {isMap && summaryOf(e) && <span className="settings-entry-sub">{summaryOf(e)}</span>}
                {origin === 'new' && <span className="settings-entry-sub">new</span>}
                {isRemoved && <span className="settings-entry-sub">removed on Apply</span>}
              </button>
              {tpl === 'providers.*.models' && origin === 'file' && !isRemoved && (
                <ModelTest provider={keyName(at.split('.')[1] ?? '')} model={String((e as { id?: unknown })?.id ?? '')} dirty={[...ctx.pending.keys()].some((p) => p.startsWith(`${at.split('.').slice(0, 2).join('.')}.`))} />
              )}
              {!ctx.disabled && <EntryRemove origin={origin} removed={isRemoved} onToggle={() => toggle(k, origin, isRemoved)} />}
            </div>
            {open === k && !isRemoved && (
              <div className="settings-entry-body">
                {origin === 'new' ? (
                  <NewEntryFields tpl={entryTpl} value={(e ?? {}) as Record<string, unknown>} onSet={(v) => ctx.change(path, { value: v })} ctx={ctx} />
                ) : (
                  <EntryFields tpl={entryTpl} at={path} value={(e ?? {}) as Record<string, unknown>} ctx={ctx} />
                )}
              </div>
            )}
          </div>
        );
      })}
      {!ctx.disabled && <button type="button" className="settings-btn" onClick={add}>+ Add</button>}
    </div>
  );
}

/** "Test" beside a model: one short question to it, as the saved
 *  configuration has it. With changes to its provider still pending,
 *  the test says to apply first. */
function ModelTest({ provider, model, dirty }: { provider: string; model: string; dirty: boolean }) {
  const [state, setState] = useState<{ busy?: boolean; text?: string; tone?: 'ok' | 'error' | 'warn' }>({});
  const run = async () => {
    setState({ busy: true });
    try {
      const r = await api.testModel(provider, model);
      setState(
        r.ok
          ? { tone: 'ok', text: `answered in ${((r.ms ?? 0) / 1000).toFixed(1)} s${r.reply ? `: “${r.reply}”` : ''}` }
          : r.note
            ? { tone: 'warn', text: r.note }
            : { tone: 'error', text: r.error ?? 'no answer' },
      );
    } catch (err) {
      setState({ tone: 'error', text: (err as Error).message });
    }
  };
  return (
    <>
      <button type="button" className="settings-text-btn" disabled={state.busy || !model} title={dirty ? 'Tests the saved configuration — apply your changes first' : 'Ask this model one short question'} onClick={() => void run()}>
        {state.busy ? 'Testing…' : 'Test'}
      </button>
      {state.text && <span className={`settings-test ${state.tone ?? ''}`} title={state.text}>{state.tone === 'ok' ? '✓ ' : state.tone === 'error' ? '✗ ' : ''}{state.text}</span>}
    </>
  );
}

function EntryRemove({ origin, removed, onToggle }: { origin: 'file' | 'new'; removed: boolean; onToggle: () => void }) {
  return removed ? (
    <button type="button" className="settings-icon-btn" title="Keep this entry" onClick={onToggle}><RotateCcw size={12} /></button>
  ) : (
    <button type="button" className="settings-icon-btn" title={origin === 'new' ? 'Drop this new entry' : 'Remove this entry'} onClick={onToggle}>−</button>
  );
}

/** A typed value from a plain text box: a number or true/false when it
 *  reads as one, text otherwise. */
function plainValue(t: string, kind?: SettingFieldInfo['valueKind']): unknown {
  if (kind === 'string') return t;
  if (/^-?\d+(\.\d+)?$/.test(t.trim())) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  return t;
}

/** The fields of an entry the file has: each change is its own path. */
function EntryFields({ tpl, at, value, ctx }: { tpl: string; at: string; value: Record<string, unknown>; ctx: EntryCtx }) {
  return (
    <>
      {childrenOf(ctx.fields, tpl).map((df) => {
        const name = df.path.split('.').pop()!;
        const path = `${at}.${name}`;
        const current = value[name];
        const pend = ctx.pending.get(path);
        const label = (
          <span className="settings-entry-label" title={df.info?.help}>
            {df.info?.label ?? humanize(name)}
            {df.required ? ' *' : ''}
          </span>
        );
        if (df.kind === 'object') {
          return <EntryBlock key={df.path} label={label} tpl={df.path} at={path} value={current} ctx={ctx} />;
        }
        if (df.kind === 'map' || df.kind === 'list') {
          return (
            <div key={df.path} className="settings-entry-group">
              {label}
              <div className="settings-entry-nested"><EntriesControl tpl={df.path} at={path} value={current} ctx={ctx} /></div>
            </div>
          );
        }
        const shown = pend && 'value' in pend ? pend.value : pend && 'reset' in pend ? undefined : current;
        return (
          <div key={df.path} className="settings-entry-field">
            {label}
            {df.info?.sensitive || isSecret(current) ? (
              <SecretControl id={`in-${path}`} set={isSecret(current) ? current.set : false} pending={!!pend && 'secret' in pend} disabled={ctx.disabled} onSecret={(s) => ctx.change(path, s === null ? null : { secret: s })} />
            ) : (
              <Control
                id={`in-${path}`}
                field={df}
                value={shown}
                disabled={ctx.disabled}
                onChange={(v) => ctx.change(path, JSON.stringify(v) === JSON.stringify(current) ? null : v === undefined || v === '' ? (current === undefined ? null : { reset: true }) : { value: v })} />
            )}
            {/* A field the entry has, not required: take it out (a switch
                cannot say "not set", e.g. transport local → resource). */}
            {!ctx.disabled && (pend ? (
              <button type="button" className="settings-icon-btn" title="Undo this change" onClick={() => ctx.change(path, null)}><RotateCcw size={12} /></button>
            ) : current !== undefined && !df.required && ctx.inFile.has(path) ? (
              <button type="button" className="settings-icon-btn" title="Remove this setting from the entry" onClick={() => ctx.change(path, { reset: true })}>↺</button>
            ) : null)}
          </div>
        );
      })}
    </>
  );
}

/** A block inside an entry (`auth`, `tools`). One the file does not
 *  have stays closed until asked for, so its required fields do not
 *  look like something missing. */
function EntryBlock({ label, tpl, at, value, ctx }: { label: ReactNode; tpl: string; at: string; value: unknown; ctx: EntryCtx }) {
  const touched = [...ctx.pending.keys()].some((k) => k.startsWith(`${at}.`));
  const [open, setOpen] = useState(value !== undefined || touched);
  return (
    <div className="settings-entry-group">
      <span className="settings-entry-field">
        {label}
        {!open && <button type="button" className="settings-text-btn" disabled={ctx.disabled} onClick={() => setOpen(true)}>Set up…</button>}
      </span>
      {open && <div className="settings-entry-nested"><EntryFields tpl={tpl} at={at} value={(value && typeof value === 'object' ? value : {}) as Record<string, unknown>} ctx={ctx} /></div>}
    </div>
  );
}

/** The fields of an entry added in this window. The whole entry —
 *  its keys, blocks and lists included — is one change, written as one
 *  block on Apply, so it is complete when the file is checked. */
function NewEntryFields({ tpl, value, onSet, ctx }: { tpl: string; value: Record<string, unknown>; onSet: (v: Record<string, unknown>) => void; ctx: EntryCtx }) {
  const set = (name: string, v: unknown) => {
    const next = { ...value };
    // A switch turned off again, where the setting has no default of its
    // own, means "not set" (transport: local off → a remote machine).
    const df = childrenOf(ctx.fields, tpl).find((x) => x.path.endsWith(`.${name}`));
    const unset = v === false && df?.kind === 'boolean' && df.default === undefined && !df.required;
    if (unset || v === undefined || v === '' || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) delete next[name];
    else next[name] = v;
    onSet(next);
  };
  return (
    <>
      {childrenOf(ctx.fields, tpl).map((df) => {
        const name = df.path.split('.').pop()!;
        const label = (
          <span className="settings-entry-label" title={df.info?.help}>
            {df.info?.label ?? humanize(name)}
            {df.required ? ' *' : ''}
          </span>
        );
        if (df.kind === 'object') {
          return (
            <div key={df.path} className="settings-entry-group">
              {label}
              <div className="settings-entry-nested">
                <NewEntryFields tpl={df.path} value={(value[name] ?? {}) as Record<string, unknown>} onSet={(v) => set(name, v)} ctx={ctx} />
              </div>
            </div>
          );
        }
        if (df.kind === 'map' || df.kind === 'list') {
          return (
            <div key={df.path} className="settings-entry-group">
              {label}
              <div className="settings-entry-nested">
                <NewEntries tpl={df.path} value={value[name]} onSet={(v) => set(name, v)} ctx={ctx} />
              </div>
            </div>
          );
        }
        if (df.info?.sensitive) {
          return (
            <div key={df.path} className="settings-entry-field">
              {label}
              <SecretControl id={`in-new-${df.path}`} set={false} pending={typeof value[name] === 'string'} disabled={ctx.disabled} onSecret={(s) => set(name, s ?? undefined)} />
            </div>
          );
        }
        return (
          <div key={df.path} className="settings-entry-field">
            {label}
            <Control id={`in-new-${df.path}-${name}`} field={df} value={value[name] === undefined ? df.default : value[name]} disabled={ctx.disabled} onChange={(v) => set(name, v)} />
          </div>
        );
      })}
    </>
  );
}

/** Entries inside an entry that is itself new: kept in its value. */
function NewEntries({ tpl, value, onSet, ctx }: { tpl: string; value: unknown; onSet: (v: unknown) => void; ctx: EntryCtx }) {
  const holder = fieldAt(ctx.fields, tpl);
  const isMap = holder?.kind === 'map';
  const plain = childrenOf(ctx.fields, `${tpl}.*`).length === 0;
  const secret = !!holder?.info?.sensitive || /headers$/.test(tpl);
  const entries: Array<[string, unknown]> = isMap
    ? Object.entries((value && typeof value === 'object' ? value : {}) as Record<string, unknown>)
    : (Array.isArray(value) ? value : []).map((v, i) => [String(i), v]);
  const write = (next: Array<[string, unknown]>) => onSet(isMap ? Object.fromEntries(next) : next.map(([, v]) => v));
  const put = (k: string, v: unknown) => write(entries.map(([x, e]) => (x === k ? [x, v] : [x, e])));
  const add = () => {
    const name = isMap ? window.prompt('Name of the new entry')?.trim() : String(entries.length);
    if (!name || entries.some(([k]) => k === name)) return;
    write([...entries, [name, plain ? '' : {}]]);
  };
  return (
    <div className="settings-entries">
      {entries.map(([k, e]) => (
        <div key={k} className={`settings-entry added ${plain ? 'plain' : ''}`}>
          {plain ? (
            <>
              <span className="settings-entry-name">{k}</span>
              {secret ? (
                <SecretControl id={`in-new-${tpl}-${k}`} set={false} pending={typeof e === 'string' && e !== ''} disabled={ctx.disabled} onSecret={(s) => put(k, s ?? '')} />
              ) : (
                <TextControl id={`in-new-${tpl}-${k}`} value={String(e ?? '')} disabled={ctx.disabled} onChange={(t) => put(k, plainValue(t, holder?.valueKind))} />
              )}
            </>
          ) : (
            <>
              <span className="settings-entry-name">{isMap ? k : summaryOf(e) || `entry ${Number(k) + 1}`}</span>
              <div className="settings-entry-body">
                <NewEntryFields tpl={`${tpl}.*`} value={(e ?? {}) as Record<string, unknown>} onSet={(v) => put(k, v)} ctx={ctx} />
              </div>
            </>
          )}
          {!ctx.disabled && <button type="button" className="settings-icon-btn" title="Drop this entry" onClick={() => write(entries.filter(([x]) => x !== k))}>−</button>}
        </div>
      ))}
      {!ctx.disabled && <button type="button" className="settings-btn" onClick={add}>+ Add</button>}
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
