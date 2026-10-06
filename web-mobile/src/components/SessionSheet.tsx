// Session and model on the phone: the header shows "agent · session"
// and the model, a tap opens this bottom sheet — the agent's sessions
// (tap to switch, "+ New" to start one, "Archived" to bring one back)
// and the model list for the open session. One sheet for both: two small tap targets side by side
// in the header are easy to miss.
//
// Thin client: lists come from GET /agents/:agent/sessions and
// GET /models, the sheet calls back with what was tapped.

import { useEffect, useRef, useState } from 'react';
import type { ModelOption, SessionModelInfo, SessionSummary } from '../../../web/src/lib/api';
import { suggestSlug, validateSessionSlug } from '../../../web/src/lib/session-slug';
import { sessionKey } from '../hooks/useActivityStream';
import {
  isActiveModel,
  isPersonaDefault,
  orderSessions,
  relativeTime,
  visibleSessions,
  type OpenSession,
} from '../hooks/session-pick';

type ModelRow = ModelOption & { unavailable?: { since: number; until: number; reason: string } };

const SESSION_LIMIT = 6;
const ARCHIVE_LIMIT = 20;

interface Props {
  open: boolean;
  onClose: () => void;
  agent: string;
  session: OpenSession;
  unreadSessions: Set<string>;
  streamingSessions: Set<string>;
  onPick: (session: OpenSession) => void;
  modelInfo: SessionModelInfo | null;
  /** null = back to the agent's default. Resolves with an error text or null. */
  onSetModel: (ref: string | null) => Promise<string | null>;
  /** A turn is running in the open session: a switch applies to the next one. */
  streaming: boolean;
}

export function SessionSheet({
  open,
  onClose,
  agent,
  session,
  unreadSessions,
  streamingSessions,
  onPick,
  modelInfo,
  onSetModel,
  streaming,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [thinking, setThinking] = useState<{ effective: string | null; source: string; modelSupportsReasoning: boolean } | null>(null);
  // null = the archived list is closed; an array once it was opened.
  const [archived, setArchived] = useState<SessionSummary[] | null>(null);
  const [archiveAll, setArchiveAll] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fresh lists every time the sheet opens — sessions come and go from
  // other clients, models get marked unreachable.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setShowAll(false);
    setNaming(false);
    setName('');
    setNote(null);
    setLoadError(null);
    setSwitching(null);
    setArchived(null);
    setArchiveAll(false);
    setRestoring(null);
    fetch(`/agents/${encodeURIComponent(agent)}/sessions`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const list = (await r.json()) as SessionSummary[];
        if (!cancelled) setSessions(list);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(`Could not load the sessions (${err instanceof Error ? err.message : String(err)})`);
      });
    fetch('/models')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const list = (await r.json()) as ModelRow[];
        if (!cancelled) setModels(list);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(`Could not load the models (${err instanceof Error ? err.message : String(err)})`);
      });
    return () => {
      cancelled = true;
    };
  }, [open, agent]);

  // The thinking level shown under the models follows the session and
  // its model (a model may bring its own default).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session.id)}/thinking`)
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => {
        if (!cancelled) setThinking(t);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, agent, session.id, modelInfo?.provider, modelInfo?.modelId]);

  // Another agent's list must not flash while the new one loads.
  useEffect(() => {
    setSessions(null);
  }, [agent]);

  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);

  if (!open) return null;

  const ordered = orderSessions((sessions ?? []) as Array<SessionSummary & { lastActivity: string | null; createdAt: string | null }>);
  const shown = visibleSessions(ordered, session.id, SESSION_LIMIT, showAll);
  const hidden = ordered.length - shown.length;
  const now = Date.now();
  const check = validateSessionSlug(name);

  const create = async () => {
    if (!check.ok || creating) return;
    setCreating(true);
    setNote(null);
    try {
      const res = await fetch(`/agents/${encodeURIComponent(agent)}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: check.slug }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; slug?: string; error?: string };
      // 409 = the name is taken by a live session: that session is the answer.
      if ((res.ok || res.status === 409) && body.id) {
        onPick({ id: body.id, slug: body.slug ?? check.slug });
        onClose();
        return;
      }
      setNote(body.error ?? `Could not create the session (HTTP ${res.status})`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const openArchive = async () => {
    setNote(null);
    try {
      const res = await fetch(`/agents/${encodeURIComponent(agent)}/sessions?include_archived=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = ((await res.json()) as SessionSummary[]).filter((s) => s.isArchived);
      const when = (s: SessionSummary) => s.archivedAt ?? s.lastActivity ?? '';
      setArchived(list.sort((a, b) => when(b).localeCompare(when(a))));
    } catch (err) {
      setNote(`Could not load the archived sessions (${err instanceof Error ? err.message : String(err)})`);
    }
  };

  // Restoring brings the session back as a normal one (a /reset archive
  // as "<name>-archive") and opens it.
  const restore = async (s: SessionSummary) => {
    if (restoring) return;
    setRestoring(s.id);
    setNote(null);
    try {
      const res = await fetch(`/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(s.id)}/unarchive`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { session?: string; slug?: string; error?: string };
      if (res.ok && body.session) {
        onPick({ id: body.session, slug: body.slug ?? s.slug });
        onClose();
        return;
      }
      setNote(body.error ?? `Could not restore the session (HTTP ${res.status})`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(null);
    }
  };

  // Compact by hand: summarise the earlier conversation and keep
  // talking. The result also arrives as a chat row over the stream.
  const compact = async () => {
    if (compacting || streaming) return;
    setCompacting(true);
    setNote(null);
    try {
      const res = await fetch(`/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session.id)}/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as { status?: string; note?: string; error?: string };
      if (res.ok && body.status === 'compacted') {
        setNote(body.note ? `Compacted. ${body.note}` : 'Compacted.');
      } else {
        setNote(body.error ?? body.note ?? `Could not compact (HTTP ${res.status})`);
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setCompacting(false);
    }
  };

  const pickModel = async (m: ModelRow) => {
    if (switching) return;
    if (isActiveModel(modelInfo, m)) return;
    setSwitching(m.ref);
    setNote(null);
    // The agent's own default is "no choice for this session", so the
    // session follows the agent when its default changes later.
    const err = await onSetModel(isPersonaDefault(modelInfo, m) ? null : m.ref);
    setSwitching(null);
    if (err) setNote(err);
  };

  return (
    <div className="work-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="work-sheet session-sheet"
        role="dialog"
        aria-label="Sessions and model"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="work-sheet-grip" aria-hidden="true" />
        {(note ?? loadError) && <div className="work-sheet-note" role="status">{note ?? loadError}</div>}

        <section className="work-section">
          <div className="session-sheet-head">
            <h3>Sessions</h3>
            {!naming && (
              <button type="button" className="session-new" onClick={() => setNaming(true)}>
                + New
              </button>
            )}
          </div>

          {naming && (
            <form
              className="session-new-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                ref={inputRef}
                className="session-new-input"
                value={name}
                onChange={(e) => setName(suggestSlug(e.target.value))}
                placeholder="name, e.g. trip-planning"
                aria-label="Name of the new session"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={60}
              />
              <button type="submit" className="session-new-go" disabled={!check.ok || creating}>
                {creating ? '…' : 'Create'}
              </button>
              <button type="button" className="work-x" onClick={() => { setNaming(false); setName(''); }} aria-label="Cancel">
                ×
              </button>
              {name.length > 0 && !check.ok && <div className="session-new-hint">{check.reason}</div>}
            </form>
          )}

          {sessions === null && !loadError && <div className="work-sheet-empty">loading…</div>}
          {shown.map((s) => {
            const active = s.id === session.id;
            const k = sessionKey(agent, s.id);
            const running = active ? streaming : streamingSessions.has(k);
            const unread = !active && unreadSessions.has(k);
            return (
              <button
                key={s.id}
                type="button"
                className={`sheet-row ${active ? 'active' : ''}`}
                aria-current={active ? 'true' : undefined}
                onClick={() => {
                  if (!active) onPick({ id: s.id, slug: s.slug });
                  onClose();
                }}
              >
                <span className="sheet-row-mark" aria-hidden="true">{active ? '●' : ''}</span>
                <span className="sheet-row-name">{s.slug}</span>
                {running && <span className="sheet-row-meta accent">running</span>}
                {unread && <span className="sheet-row-dot" aria-label="unread" />}
                <span className="sheet-row-meta">{s.messageCount === 0 ? 'empty' : relativeTime(s.lastActivity, now)}</span>
              </button>
            );
          })}
          {hidden > 0 && (
            <button type="button" className="sheet-row more" onClick={() => setShowAll(true)}>
              <span className="sheet-row-mark" aria-hidden="true" />
              <span className="sheet-row-name">Show all ({ordered.length})</span>
            </button>
          )}
          <button
            type="button"
            className="sheet-row more compact-row"
            disabled={streaming || compacting}
            onClick={() => void compact()}
          >
            <span className="sheet-row-mark" aria-hidden="true">{compacting ? '…' : ''}</span>
            <span className="sheet-row-name">{compacting ? 'Compacting…' : 'Compact this conversation'}</span>
            <span className="sheet-row-meta">{streaming ? 'after the turn' : 'keeps the session'}</span>
          </button>
          <button
            type="button"
            className="sheet-row more archive-toggle"
            aria-expanded={archived !== null}
            onClick={() => (archived === null ? void openArchive() : setArchived(null))}
          >
            <span className="sheet-row-mark" aria-hidden="true">{archived === null ? '▸' : '▾'}</span>
            <span className="sheet-row-name">Archived</span>
          </button>
          {archived !== null && archived.length === 0 && <div className="work-sheet-empty">no archived sessions</div>}
          {(archived ?? []).slice(0, archiveAll ? undefined : ARCHIVE_LIMIT).map((s) => (
            <div key={s.id} className="sheet-row archived-row">
              <span className="sheet-row-mark" aria-hidden="true" />
              <span className="sheet-row-name">{s.slug}</span>
              <span className="sheet-row-meta">{relativeTime(s.archivedAt ?? s.lastActivity, now)}</span>
              <button
                type="button"
                className="archived-restore"
                disabled={restoring !== null}
                onClick={() => void restore(s)}
                aria-label={`Restore ${s.slug}`}
              >
                {restoring === s.id ? '…' : 'Restore'}
              </button>
            </div>
          ))}
          {archived !== null && !archiveAll && archived.length > ARCHIVE_LIMIT && (
            <button type="button" className="sheet-row more" onClick={() => setArchiveAll(true)}>
              <span className="sheet-row-mark" aria-hidden="true" />
              <span className="sheet-row-name">Show all archived ({archived.length})</span>
            </button>
          )}
        </section>

        <section className="work-section">
          <div className="session-sheet-head">
            <h3>Model for this session</h3>
            {streaming && <span className="sheet-row-meta">applies from the next turn</span>}
          </div>
          {thinking?.modelSupportsReasoning && (
            <div className="sheet-row-meta sheet-thinking">
              thinking: {thinking.effective ?? 'model decides'}
              {' · '}
              {thinking.source === 'session-override'
                ? 'set for this session'
                : thinking.source === 'persona-default'
                  ? "agent's default"
                  : thinking.source === 'model-default'
                    ? "model's default"
                    : 'nothing set'}
            </div>
          )}
          {models === null && !loadError && <div className="work-sheet-empty">loading…</div>}
          {(models ?? []).map((m) => {
            const active = isActiveModel(modelInfo, m);
            const isDefault = isPersonaDefault(modelInfo, m);
            return (
              <button
                key={`${m.provider}/${m.id}`}
                type="button"
                className={`sheet-row ${active ? 'active' : ''}`}
                aria-current={active ? 'true' : undefined}
                disabled={switching !== null}
                onClick={() => void pickModel(m)}
              >
                <span className="sheet-row-mark" aria-hidden="true">{active ? '●' : switching === m.ref ? '…' : ''}</span>
                <span className="sheet-row-name">{m.alias ?? m.id}</span>
                {isDefault && <span className="sheet-row-tag">default</span>}
                {m.unavailable && <span className="sheet-row-tag warn">unreachable</span>}
                <span className="sheet-row-meta">{m.provider}</span>
              </button>
            );
          })}
        </section>
      </div>
    </div>
  );
}
