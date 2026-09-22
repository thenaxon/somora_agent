// The task panel docked to the right of a builder's chat window
// (docs/builder.md): mode and phase switches, the Go button, the task
// list the builder keeps with todo_write, and the question it asked
// with ask_user — answered here with buttons or free text.

import { useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Circle, CircleDot, Play, Zap } from 'lucide-react';
import { api, type BuilderQuestionDto, type BuilderStateDto } from '../lib/api';
import { useBuilderSession } from '../hooks/useBuilderSession';

/** Below this chat-window width the panel collapses on its own. */
const NARROW_PX = 640;

export function BuilderPanel({
  agent,
  session,
  hostRef,
  onCollapsedChange,
}: {
  agent: string;
  session: string;
  /** The chat window's root element — observed for width. */
  hostRef: React.RefObject<HTMLElement | null>;
  /** Tells the chat window to reserve the strip instead of the column. */
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const { data, refresh } = useBuilderSession(agent, session, true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const state = data?.state ?? null;
  // Collapsed by hand (remembered per agent) or because the window is
  // narrow. The chat window owns the class that reserves the room — the
  // panel only reports; it never touches the DOM outside itself.
  const collapseKey = `somora.web.builderPanel.collapsed.${agent}`;
  const [userCollapsed, setUserCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(collapseKey) === '1';
    } catch {
      return false;
    }
  });
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let ro: ResizeObserver | undefined;
    try {
      // Border-box width: the content box shrinks by the room the panel
      // reserves, so measuring it made collapse and expand chase each
      // other around the threshold (flicker, 2026-09-23).
      ro = new ResizeObserver(() => {
        const w = host.getBoundingClientRect().width;
        setNarrow(w < NARROW_PX);
      });
      ro.observe(host);
    } catch {
      /* no observer — the person can still collapse by hand */
    }
    return () => ro?.disconnect();
  }, [hostRef]);
  const collapsed = userCollapsed || narrow;
  useEffect(() => {
    onCollapsedChange(collapsed);
  }, [collapsed, onCollapsedChange]);
  const toggleCollapsed = () => {
    setUserCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(collapseKey, next ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };
  const patch = async (p: { mode?: 'attended' | 'unattended'; phase?: 'plan' | 'build' }) => {
    setBusy('patch');
    try {
      await api.patchBuilder(agent, session, p);
      refresh();
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const go = async () => {
    setBusy('go');
    try {
      await api.builderGo(agent, session);
      refresh();
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Every hook above this line, whatever is rendered: an early return
  // before a hook changes the hook order between renders and takes the
  // whole app down (React #300 — the black screen of 2026-09-23).
  if (collapsed) {
    const open = state?.todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length ?? 0;
    return (
      <aside className="builder-panel is-collapsed" aria-label="Builder panel (collapsed)">
        <button
          type="button"
          className="builder-panel-toggle"
          title={narrow && !userCollapsed ? 'Window too narrow for the panel — widen it' : `Show the builder panel${open ? ` (${open} open task${open === 1 ? '' : 's'})` : ''}`}
          onClick={toggleCollapsed}
        >
          <ChevronLeft size={14} />
        </button>
        {data?.question && <Zap size={12} style={{ color: 'var(--accent, #d9a400)', marginTop: 6 }} />}
      </aside>
    );
  }


  return (
    <aside className="builder-panel" aria-label="Builder panel">
      <div className="builder-panel-head">
        <div className="builder-panel-topline">
          <div className="builder-panel-title">
            <Zap size={12} /> Builder
          </div>
          <button type="button" className="builder-panel-toggle" title="Hide the builder panel" onClick={toggleCollapsed}>
            <ChevronRight size={14} />
          </button>
        </div>
        {state ? (
          <div className="builder-panel-switches">
            <button
              type="button"
              className={`builder-switch${state.mode === 'attended' ? ' is-on' : ''}`}
              title={
                state.mode === 'attended'
                  ? 'Attended: the builder may ask you questions here. Click for unattended.'
                  : 'Unattended: the builder decides on its own and notes decisions in the report. Click for attended.'
              }
              disabled={busy !== null}
              onClick={() => patch({ mode: state.mode === 'attended' ? 'unattended' : 'attended' })}
            >
              {state.mode}
            </button>
            <button
              type="button"
              className={`builder-switch${state.phase === 'plan' ? ' is-plan' : ' is-build'}`}
              title={
                state.phase === 'plan'
                  ? 'Plan phase: read-only, writes only the plan file. Press Go to start building.'
                  : 'Build phase: edits, runs, tests. Click to go back to planning.'
              }
              disabled={busy !== null}
              onClick={() => patch({ phase: state.phase === 'plan' ? 'build' : 'plan' })}
            >
              {state.phase}
            </button>
            {state.phase === 'plan' && (
              <button
                type="button"
                className="builder-go"
                title="Approve the plan and start building (sends the Go into the session)"
                disabled={busy !== null}
                onClick={go}
              >
                <Play size={11} fill="currentColor" /> Go
              </button>
            )}
          </div>
        ) : (
          <div className="builder-panel-muted">No builder state yet — it appears with the first message.</div>
        )}
        {state?.planPath && (
          <div className="builder-panel-muted" title={state.planPath}>
            plan: <code>{state.planPath.split('/').slice(-2).join('/')}</code>
          </div>
        )}
      </div>

      {data?.question && <QuestionCard agent={agent} session={session} q={data.question} onDone={refresh} />}

      <div className="builder-todos">
        <div className="builder-section-title">Tasks{state && state.todos.length > 0 ? ` · ${state.todos.filter((t) => t.status === 'completed').length}/${state.todos.length}` : ''}</div>
        {!state || state.todos.length === 0 ? (
          <div className="builder-panel-muted">The builder writes its task list here (todo_write).</div>
        ) : (
          <ul className="builder-todo-list">
            {state.todos.map((t, i) => (
              <li key={`${i}-${t.content}`} className={`builder-todo is-${t.status}`}>
                {t.status === 'completed' ? (
                  <Check size={12} />
                ) : t.status === 'in_progress' ? (
                  <CircleDot size={12} />
                ) : (
                  <Circle size={12} />
                )}
                <span>{t.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {notice && <div className="builder-panel-notice">{notice}</div>}
    </aside>
  );
}

function QuestionCard({
  agent,
  session,
  q,
  onDone,
}: {
  agent: string;
  session: string;
  q: BuilderQuestionDto;
  onDone: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (label: string) => {
    setChosen((prev) => (q.multiple ? (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]) : [label]));
  };
  const submit = async () => {
    if (chosen.length === 0 && !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.answerQuestion(agent, session, q.questionId, chosen, text.trim() || undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  const minutesLeft = Math.max(0, Math.round((q.expiresAt - Date.now()) / 60000));
  return (
    <div className="builder-question">
      <div className="builder-section-title">{q.header ?? 'Question'}</div>
      <div className="builder-question-text">{q.question}</div>
      <div className="builder-question-options">
        {q.options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`builder-option${chosen.includes(o.label) ? ' is-chosen' : ''}`}
            title={o.description ?? ''}
            disabled={sending}
            onClick={() => toggle(o.label)}
          >
            {o.label}
            {o.description && <small>{o.description}</small>}
          </button>
        ))}
      </div>
      <textarea
        className="builder-question-free"
        placeholder="or answer in your own words…"
        rows={2}
        value={text}
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="builder-question-foot">
        <span className="builder-panel-muted">{minutesLeft} min left</span>
        <button type="button" className="builder-go" disabled={sending || (chosen.length === 0 && !text.trim())} onClick={submit}>
          Answer
        </button>
      </div>
      {error && <div className="builder-panel-notice">{error}</div>}
    </div>
  );
}

export type { BuilderStateDto };
