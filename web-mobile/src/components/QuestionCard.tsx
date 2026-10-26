// An open question of the session, as a card above the input — the
// phone version of the web's QuestionCard (docs/external-agents.md): an
// external agent asks "may I run this?", one button per option. Polled
// while a turn runs, re-read on question events. Without an answer the
// server takes the safest option when the time runs out. A question that
// does not wait (docs/agents.md) stays between turns: a tap sends the
// choice as your next message, and writing anything else answers it too.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionQuestion, SessionQuestionAnswer } from '../../../web/src/lib/api';
import { answersOnClick, buildAnswer, questionParts } from '../../../web/src/lib/question';
import type { TurnQueueEvent } from '../hooks/useChatStream';

const POLL_MS = 1500;

function remaining(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
}

const KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

/** An external agent's option carries its kind as description; a
 *  builder's carries an explanation for the person. */
function tone(description: string | undefined): string {
  if (!description || !KINDS.has(description)) return '';
  return description.startsWith('allow') ? 'allow' : 'reject';
}

export function useSessionQuestion(
  agent: string | null,
  session: string,
  streaming: boolean,
  subscribeTurnEvents?: (handler: (event: TurnQueueEvent) => void) => () => void,
): { question: SessionQuestion | null; refresh: () => void } {
  const [question, setQuestion] = useState<SessionQuestion | null>(null);
  const current = useRef({ agent, session });
  current.current = { agent, session };
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    const { agent: a, session: s } = current.current;
    if (!a) return;
    if (retry.current) clearTimeout(retry.current);
    // A read that fails on the network (the event came, the fetch did
    // not — a short drop) is tried again a few times; else the card stays
    // unseen until the next event (review 2026-10-26).
    const attempt = (left: number) => {
      fetch(`/agents/${encodeURIComponent(a)}/sessions/${encodeURIComponent(s)}/question`)
        .then((r) => (r.ok ? (r.json() as Promise<{ question: SessionQuestion | null }>) : null))
        .then((d) => {
          if (d && current.current.agent === a && current.current.session === s) setQuestion(d.question);
        })
        .catch(() => {
          if (left > 0 && current.current.agent === a && current.current.session === s) retry.current = setTimeout(() => attempt(left - 1), 2500);
        });
    };
    attempt(4);
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
  useEffect(() => subscribeTurnEvents?.((event) => event === 'question' && refresh()), [subscribeTurnEvents, refresh]);
  return { question, refresh };
}

async function postAnswer(agent: string, session: string, questionId: string, body: SessionQuestionAnswer): Promise<void> {
  const res = await fetch(`/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/questions/${encodeURIComponent(questionId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}

export function QuestionCard({ agent, session, question, onAnswered }: { agent: string; session: string; question: SessionQuestion; onAnswered: () => void }) {
  if (question.async) return <AsyncQuestionCard agent={agent} session={session} question={question} onAnswered={onAnswered} />;
  return <WaitingQuestionCard agent={agent} session={session} question={question} onAnswered={onAnswered} />;
}

function WaitingQuestionCard({ agent, session, question, onAnswered }: { agent: string; session: string; question: SessionQuestion; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A question with several answers allowed: tap to pick, then send.
  const [picked, setPicked] = useState<string[]>([]);
  const answer = async (labels: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await postAnswer(agent, session, question.id, { answers: labels });
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
        {question.options.map((o) => {
          const on = picked.includes(o.label);
          const note = o.description && !KINDS.has(o.description) ? o.description : null;
          return (
            <button
              key={o.label}
              type="button"
              disabled={busy}
              className={`${tone(o.description)} ${on ? 'picked' : ''}`}
              aria-pressed={question.multiple ? on : undefined}
              data-testid={`question-option-${o.label}`}
              onClick={() => (question.multiple ? setPicked((p) => (on ? p.filter((x) => x !== o.label) : [...p, o.label])) : void answer([o.label]))}
            >
              <span>{o.label}</span>
              {note && <span className="question-option-note">{note}</span>}
            </button>
          );
        })}
      </div>
      {question.multiple && (
        <button type="button" className="question-card-send" disabled={busy || picked.length === 0} onClick={() => void answer(picked)}>
          Send {picked.length > 0 ? `(${picked.length})` : ''}
        </button>
      )}
      {error && <div className="question-card-error">{error}</div>}
    </div>
  );
}

/** A question that does not wait: one or several, each with options (or
 *  a line for your own words). The answer goes out as your next message. */
function AsyncQuestionCard({ agent, session, question, onAnswered }: { agent: string; session: string; question: SessionQuestion; onAnswered: () => void }) {
  const parts = questionParts(question);
  const oneClick = answersOnClick(question);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[][]>(() => parts.map(() => []));
  const [texts, setTexts] = useState<string[]>(() => parts.map(() => ''));
  const send = async (body: SessionQuestionAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await postAnswer(agent, session, question.id, body);
      onAnswered();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (i: number, label: string, multiple: boolean) => {
    if (oneClick) return void send({ answers: [label] });
    setPicks((all) =>
      all.map((p, j) => (j !== i ? p : multiple ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : p[0] === label ? [] : [label])),
    );
  };
  const body = buildAnswer(question, picks, texts);
  return (
    <div className="question-card async" data-testid="question-card" data-async="true" role="group" aria-label={question.header ?? 'Question'}>
      <div className="question-card-head">
        <span>{question.header ?? (parts.length > 1 ? `${parts.length} questions` : 'Question')}</span>
        <span className="question-card-wait">answer any time</span>
      </div>
      {parts.map((p, i) => (
        <div key={i} className="question-card-part">
          <div className="question-card-text">{p.question}</div>
          {p.options.length > 0 ? (
            <div className="question-card-options">
              {p.options.map((o) => {
                const on = (picks[i] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={busy}
                    className={on ? 'picked' : ''}
                    aria-pressed={oneClick ? undefined : on}
                    data-testid={`question-option-${o.label}`}
                    onClick={() => pick(i, o.label, p.multiple)}
                  >
                    <span>{o.label}</span>
                    {o.description && <span className="question-option-note">{o.description}</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <input
              type="text"
              className="question-card-input"
              value={texts[i] ?? ''}
              disabled={busy}
              placeholder="Your answer"
              data-testid={`question-text-${i}`}
              onChange={(e) => setTexts((all) => all.map((t, j) => (j === i ? e.target.value : t)))}
            />
          )}
        </div>
      ))}
      {!oneClick && (
        <button type="button" className="question-card-send" data-testid="question-send" disabled={busy || !body} onClick={() => body && void send(body)}>
          Send
        </button>
      )}
      <div className="question-card-hint">or write your own answer below</div>
      {error && <div className="question-card-error">{error}</div>}
    </div>
  );
}
