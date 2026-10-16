// An open question of the session, as a card above the input — the
// phone version of the web's QuestionCard (docs/external-agents.md): an
// external agent asks "may I run this?", one button per option. Polled
// while a turn runs; a question only ever comes up during one. Without
// an answer the server takes the safest option when the time runs out.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionQuestion } from '../../../web/src/lib/api';

const POLL_MS = 1500;

function remaining(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
}

function tone(kind: string | undefined): string {
  if (kind?.startsWith('allow')) return 'allow';
  if (kind?.startsWith('reject')) return 'reject';
  return '';
}

export function useSessionQuestion(agent: string | null, session: string, streaming: boolean): { question: SessionQuestion | null; refresh: () => void } {
  const [question, setQuestion] = useState<SessionQuestion | null>(null);
  const current = useRef({ agent, session });
  current.current = { agent, session };
  const refresh = useCallback(() => {
    const { agent: a, session: s } = current.current;
    if (!a) return;
    fetch(`/agents/${encodeURIComponent(a)}/sessions/${encodeURIComponent(s)}/question`)
      .then((r) => (r.ok ? (r.json() as Promise<{ question: SessionQuestion | null }>) : null))
      .then((d) => {
        if (d && current.current.agent === a && current.current.session === s) setQuestion(d.question);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    setQuestion(null);
    refresh();
  }, [agent, session, refresh]);
  useEffect(() => {
    // One more look when the turn ends clears an answered card.
    refresh();
    if (!streaming) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [streaming, refresh]);
  return { question, refresh };
}

export function QuestionCard({ agent, session, question, onAnswered }: { agent: string; session: string; question: SessionQuestion; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (label: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/questions/${encodeURIComponent(question.id)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [label] }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      onAnswered();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="question-card" data-testid="question-card" role="group" aria-label={question.header ?? 'Question'}>
      <div className="question-card-head">
        <span>{question.header ?? 'Question'}</span>
        <span className="question-card-wait" title="Without an answer the safest option is taken">waits {remaining(question.expiresAt)}</span>
      </div>
      <div className="question-card-text">{question.question}</div>
      <div className="question-card-options">
        {question.options.map((o) => (
          <button key={o.label} type="button" disabled={busy} className={tone(o.description)} data-testid={`question-option-${o.label}`} onClick={() => void answer(o.label)}>
            {o.label}
          </button>
        ))}
      </div>
      {error && <div className="question-card-error">{error}</div>}
    </div>
  );
}
