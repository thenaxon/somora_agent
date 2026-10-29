// The tool activity of one turn (docs/mobile.md "Tool activity"),
// drawn when the session's tool switch is on. While the turn runs: who
// is working, for how long, how many calls, a builder's current task
// and the last three calls. Once it ended: one line. A tap opens all
// calls and, for a builder's latest turn, its task and acceptance
// lists to read (they are changed in the web client).

import { useEffect, useState } from 'react';
import { formatDuration, type Activity, type ActivityStep } from '../hooks/activity';
import type { BuilderTurnInfo } from '../hooks/useBuilderTurn';

const LAST_STEPS = 3;

interface Props {
  agent: string;
  activity: Activity;
  /** This turn is the one running now. */
  live: boolean;
  /** When the running turn started, from the session's work queue. */
  liveStartedAt?: number;
  /** A builder's lists and running turn; only for the session's latest
   *  activity row, where they describe this turn. */
  builder?: BuilderTurnInfo | null;
  color?: string;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const TODO_GLYPH: Record<string, string> = { completed: '✓', in_progress: '▶', pending: '○', cancelled: '–' };

export function ActivityBlock({ agent, activity, live, liveStartedAt, builder, color }: Props) {
  const [open, setOpen] = useState(false);
  const now = useNow(live);
  const turn = live ? builder?.turn ?? null : null;
  const startedAt = turn?.startedAt ?? liveStartedAt ?? activity.startedAt;
  const lastStep = activity.steps[activity.steps.length - 1];
  const endedAt = activity.endedAt ?? lastStep?.ts ?? activity.startedAt;
  const elapsed = (live ? now : endedAt) - startedAt;
  const calls = Math.max(turn?.toolCalls ?? 0, activity.total);
  const callsText = `${calls} tool call${calls === 1 ? '' : 's'}`;

  const todos = builder?.todos ?? [];
  const doneTodos = todos.filter((t) => t.status === 'completed').length;
  const currentIdx = todos.findIndex((t) => t.status === 'in_progress');
  const current = currentIdx >= 0 ? todos[currentIdx] : undefined;
  const acceptance = builder?.acceptance ?? [];
  const passed = acceptance.filter((i) => i.status === 'passed').length;

  const style = color ? { borderColor: `${color}55`, background: `${color}12` } : undefined;
  const shown = open ? activity.steps : activity.steps.slice(-LAST_STEPS);
  const hidden = activity.total - activity.steps.length;

  if (!live && !open) {
    const bits = [callsText, formatDuration(elapsed)];
    if (todos.length > 0) bits.push(`tasks ${doneTodos}/${todos.length}`);
    if (acceptance.length > 0) bits.push(`acceptance ${passed}/${acceptance.length} passed`);
    return (
      <div className="activity-row">
        <button type="button" className="activity-line" onClick={() => setOpen(true)} aria-expanded={false}>
          <span aria-hidden="true">▸</span> {bits.join(' · ')}
        </button>
      </div>
    );
  }

  return (
    <div className="activity-row">
      <div className={`activity-block ${live ? 'live' : ''}`} style={style}>
        <button
          type="button"
          className="activity-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {live ? (
            <span>
              <strong>{agent}</strong> is working · {formatDuration(elapsed)} · {callsText}
            </span>
          ) : (
            <span>
              <span aria-hidden="true">▾</span> {callsText} · {formatDuration(elapsed)}
            </span>
          )}
        </button>
        {live && current && (
          <div className="activity-task">
            Task {currentIdx + 1} of {todos.length}: {current.content}
          </div>
        )}
        {open && todos.length > 0 && (
          <div className="activity-section">
            <div className="activity-section-title">Tasks {doneTodos}/{todos.length}</div>
            <ul className="activity-list">
              {todos.map((t, i) => (
                <li key={i} className={`todo-${t.status}`}>
                  <span className="activity-glyph" aria-hidden="true">{TODO_GLYPH[t.status] ?? '○'}</span>
                  {t.content}
                </li>
              ))}
            </ul>
          </div>
        )}
        {open && acceptance.length > 0 && (
          <div className="activity-section">
            <div className="activity-section-title">Acceptance {passed}/{acceptance.length} passed</div>
            <ul className="activity-list">
              {acceptance.map((a) => (
                <li key={a.id}>
                  <span className="activity-id">{a.id}</span> <span className={`acc-${a.status}`}>{a.status.replace('_', ' ')}</span>
                  {a.review ? ` · ${a.review.verdict}` : ''} — {a.requirement}
                </li>
              ))}
            </ul>
          </div>
        )}
        {open && hidden > 0 && <div className="activity-more">{hidden} earlier calls not shown</div>}
        <ul className={`activity-steps ${open ? 'all' : ''}`}>
          {shown.map((s, i) => (
            <StepLine key={`${s.callId ?? ''}${s.ts}-${i}`} step={s} latest={live && s === lastStep} now={now} />
          ))}
        </ul>
        {!open && (
          <button type="button" className="activity-hint" onClick={() => setOpen(true)}>
            {todos.length > 0 ? 'Tap for all tasks and calls' : 'Tap for all calls'}
          </button>
        )}
      </div>
    </div>
  );
}

function StepLine({ step, latest, now }: { step: ActivityStep; latest: boolean; now: number }) {
  let status: string;
  if (step.state === 'error') status = 'failed';
  else if (step.state === 'running' && latest) status = `running for ${formatDuration(now - step.ts)}`;
  else status = '';
  return (
    <li className={`activity-step ${step.state}`}>
      <span className="activity-tool">{step.tool}</span>
      {step.label && <span className="activity-label">{step.label}</span>}
      {status && <span className="activity-status">{status}</span>}
      {step.state === 'error' && step.error && <span className="activity-error">{step.error}</span>}
    </li>
  );
}
