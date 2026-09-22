// The task panel docked to the right of a builder's chat window
// (docs/builder.md): mode and phase switches, the Go button, the task
// list the builder keeps with todo_write, and the question it asked
// with ask_user — answered here with buttons or free text.

import { useEffect, useState } from 'react';
import { Check, Circle, CircleDot, Play, Zap } from 'lucide-react';
import { api, type BuilderQuestionDto, type BuilderStateDto } from '../lib/api';
import { useBuilderSession } from '../hooks/useBuilderSession';

export function BuilderPanel({ agent, session }: { agent: string; session: string }) {
  const { data, refresh } = useBuilderSession(agent, session, true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const state = data?.state ?? null;

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

  return (
    <aside className="builder-panel" aria-label="Builder panel">
      <div className="builder-panel-head">
        <div className="builder-panel-title">
          <Zap size={12} /> Builder
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
            plan: <a href={state.planPath}>{state.planPath.split('/').slice(-2).join('/')}</a>
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
