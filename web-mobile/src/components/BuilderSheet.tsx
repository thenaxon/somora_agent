// The builder panel on the phone (docs/mobile.md "Builder panel"): the
// web's task panel as a bottom sheet, opened from the header of a
// builder session. Mode, phase and acceptance-list switches, Go, the
// running turn, the task list and the acceptance list with a review per
// item. A question the builder asks is answered on the card above the
// input, as for every agent.

import { useEffect, useState } from 'react';
import { formatDuration } from '../hooks/activity';
import type { BuilderPanelAcceptanceItem, BuilderPanelData } from '../hooks/useBuilderPanel';

interface Props {
  open: boolean;
  onClose: () => void;
  agent: string;
  data: BuilderPanelData | null;
  actions: {
    patch: (p: { mode?: 'attended' | 'unattended'; phase?: 'plan' | 'build'; acceptanceRequired?: boolean }) => Promise<void>;
    go: () => Promise<void>;
    review: (id: string, verdict: 'accepted' | 'rejected', note?: string) => Promise<void>;
  };
  refresh: () => void;
}

const TODO_GLYPH: Record<string, string> = { completed: '✓', in_progress: '▶', pending: '○', cancelled: '–' };
const ACC_GLYPH: Record<string, string> = { passed: '✓', failed: '✗', not_run: '–', open: '○' };

export function BuilderSheet({ open, onClose, agent, data, actions, refresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = data?.turn ?? null;
  useEffect(() => {
    if (!open || !running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, running]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);

  if (!open) return null;

  /** True when the call went through; a failure shows in the note bar. */
  const run = async (what: string, f: () => Promise<void>): Promise<boolean> => {
    setBusy(what);
    try {
      await f();
      refresh();
      return true;
    } catch (err) {
      setNote((err as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const state = data?.state ?? null;
  const todos = state?.todos ?? [];
  const doneTodos = todos.filter((t) => t.status === 'completed').length;
  const acc = data?.acceptance ?? { items: [], required: false };
  const passed = acc.items.filter((i) => i.status === 'passed').length;
  const accepted = acc.items.filter((i) => i.review?.verdict === 'accepted').length;

  return (
    <div className="work-sheet-backdrop" onClick={onClose} role="presentation">
      <div className="work-sheet builder-sheet" role="dialog" aria-label={`Builder panel of ${agent}`} onClick={(e) => e.stopPropagation()}>
        <div className="work-sheet-grip" aria-hidden="true" />
        {note && <div className="work-sheet-note" role="status">{note}</div>}
        {!data ? (
          <div className="work-sheet-empty">reading the builder panel…</div>
        ) : !state ? (
          <div className="work-sheet-empty">No builder state yet — it appears with the first message.</div>
        ) : (
          <>
            {running && (
              <div className="builder-progress">
                <span className="builder-progress-dot" aria-hidden="true" />
                running for {formatDuration(now - running.startedAt)} · {running.toolCalls} tool call{running.toolCalls === 1 ? '' : 's'}
                {running.lastTool && <> · <code>{running.lastTool}</code></>}
              </div>
            )}
            <div className="builder-switches">
              <button
                type="button"
                className={`builder-switch ${state.mode === 'attended' ? 'on' : ''}`}
                disabled={busy !== null}
                aria-label={`Mode ${state.mode} — tap for ${state.mode === 'attended' ? 'unattended' : 'attended'}`}
                onClick={() => void run('mode', () => actions.patch({ mode: state.mode === 'attended' ? 'unattended' : 'attended' }))}
              >
                {state.mode}
              </button>
              <button
                type="button"
                className={`builder-switch ${state.phase === 'plan' ? 'plan' : 'on'}`}
                disabled={busy !== null}
                aria-label={`Phase ${state.phase} — tap for ${state.phase === 'plan' ? 'build' : 'plan'}`}
                onClick={() => void run('phase', () => actions.patch({ phase: state.phase === 'plan' ? 'build' : 'plan' }))}
              >
                {state.phase}
              </button>
              <button
                type="button"
                className={`builder-switch ${acc.required ? 'on' : ''}`}
                disabled={busy !== null}
                aria-pressed={acc.required}
                aria-label={acc.required ? 'Acceptance list required — tap to make it optional' : 'Acceptance list optional — tap to require it'}
                onClick={() => void run('list', () => actions.patch({ acceptanceRequired: !acc.required }))}
              >
                {acc.required ? 'list required' : 'list optional'}
              </button>
              {state.phase === 'plan' && (
                <button type="button" className="builder-go" disabled={busy !== null} onClick={() => void run('go', actions.go)}>
                  ▶ Go
                </button>
              )}
            </div>
            <div className="builder-hint">
              {acc.required
                ? 'The builder keeps one item per requirement with its evidence and is sent back when it stops with the list missing or items open.'
                : 'Tap “list optional” to hold the builder to an acceptance list for this session.'}
            </div>
            {state.planPath && (
              <div className="builder-muted">
                plan: <code>{state.planPath.split('/').slice(-2).join('/')}</code>
              </div>
            )}
            {data.writeAllow.length > 0 && (
              <div className="builder-muted">also writes in: {data.writeAllow.map((f) => <code key={f}>{f} </code>)}</div>
            )}
            {data.question && <div className="builder-question-hint">The builder asks: “{data.question.question}” — answer on the card above the input.</div>}

            <section className="work-section">
              <h3>Tasks{todos.length > 0 ? ` · ${doneTodos}/${todos.length}` : ''}</h3>
              {todos.length === 0 ? (
                <div className="builder-muted">The builder writes its task list here.</div>
              ) : (
                <ul className="builder-list">
                  {todos.map((t, i) => (
                    <li key={`${i}-${t.content}`} className={`todo-${t.status}`}>
                      <span className="builder-glyph" aria-hidden="true">{TODO_GLYPH[t.status] ?? '○'}</span>
                      <span>{t.content}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {(acc.items.length > 0 || acc.required) && (
              <section className="work-section">
                <h3>Acceptance{acc.items.length > 0 ? ` · ${passed}/${acc.items.length} passed · ${accepted} accepted` : ''}</h3>
                {acc.items.length === 0 ? (
                  <div className="builder-muted">Required — the builder writes one item per requirement here.</div>
                ) : (
                  <ul className="builder-acc-list">
                    {acc.items.map((i) => (
                      <AcceptanceItem key={i.id} item={i} disabled={busy !== null} onReview={(verdict, n) => run(i.id, () => actions.review(i.id, verdict, n))} />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AcceptanceItem({
  item,
  disabled,
  onReview,
}: {
  item: BuilderPanelAcceptanceItem;
  disabled: boolean;
  onReview: (verdict: 'accepted' | 'rejected', note?: string) => Promise<boolean>;
}) {
  const [full, setFull] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [text, setText] = useState('');
  return (
    <li className={`builder-acc is-${item.status}`}>
      <button type="button" className="builder-acc-main" onClick={() => setFull((v) => !v)} aria-expanded={full}>
        <span className={`builder-glyph acc-${item.status}`} aria-hidden="true">{ACC_GLYPH[item.status] ?? '○'}</span>
        <code>{item.id}</code> <span className="builder-acc-req">{item.requirement}</span>
      </button>
      <div className="builder-acc-meta">
        <span className={`acc-${item.status}`}>{item.status.replace('_', ' ')}</span>
        {item.evidence && <span className={`builder-acc-evidence ${full ? 'full' : ''}`}> · {item.evidence}</span>}
      </div>
      <div className="builder-acc-review">
        {item.review ? (
          <span className={`builder-verdict ${item.review.verdict}`}>
            {item.review.verdict} by {item.review.by}
            {item.review.note ? `: ${item.review.note}` : ''}
          </span>
        ) : (
          <span className="builder-muted">not reviewed</span>
        )}
        <button type="button" className="builder-review-btn" disabled={disabled} aria-label={`Accept ${item.id}`} onClick={() => void onReview('accepted')}>
          accept
        </button>
        <button type="button" className="builder-review-btn" disabled={disabled} aria-label={`Reject ${item.id}`} onClick={() => setRejecting((v) => !v)}>
          reject
        </button>
      </div>
      {rejecting && (
        <div className="builder-reject">
          <textarea rows={2} placeholder={`Why is ${item.id} rejected? (goes to the builder's list)`} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="builder-reject-foot">
            <button type="button" className="builder-switch" onClick={() => setRejecting(false)}>
              cancel
            </button>
            <button
              type="button"
              className="builder-go"
              disabled={disabled}
              onClick={() =>
                void onReview('rejected', text.trim() || undefined).then((ok) => {
                  // A failed review keeps the form and the reason typed.
                  if (!ok) return;
                  setRejecting(false);
                  setText('');
                })
              }
            >
              reject
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** The header button of a builder session: open tasks as a count. */
export function BuilderButton({ open, onToggle, openTasks, color }: { open: boolean; onToggle: () => void; openTasks: number; color?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Builder panel${openTasks > 0 ? `, ${openTasks} open task${openTasks === 1 ? '' : 's'}` : ''}`}
      title="Builder panel: mode, phase, Go, tasks and acceptance list"
      className={`header-tools header-builder ${open ? 'on' : ''} ${openTasks > 0 ? 'has-count' : ''}`}
      style={open && color ? { borderColor: `${color}88`, background: `${color}25`, color } : undefined}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <path d="m9 14 2 2 4-4" />
      </svg>
      <span>builder</span>
      {openTasks > 0 && <b className="header-builder-count">{openTasks}</b>}
    </button>
  );
}
