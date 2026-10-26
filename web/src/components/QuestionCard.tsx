// An open question of the session, as a card above the input: an external
// agent asking "may I run this?" (docs/external-agents.md). One button per
// option; the turn waits until one is clicked or the time runs out (then
// the server picks the safest option). The builder keeps its own panel.
// A question that does not wait (an agent's ask_user in a chat with you,
// Codex's own question) has its own card below: the turn is over, a click
// sends the choice as your next message, and writing anything else in
// the chat answers it too.

import { useState } from 'react';
import { MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import { api, type SessionQuestion } from '../lib/api';
import { answersOnClick, buildAnswer, questionParts } from '../lib/question';

function remaining(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
}

const KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

/** Tone of a button: an external agent's option carries its kind as
 *  description; an agent's ask_user option carries an explanation. */
function tone(description: string | undefined): 'allow' | 'reject' | 'plain' {
  if (!description || !KINDS.has(description)) return 'plain';
  return description.startsWith('allow') ? 'allow' : 'reject';
}

export function QuestionCard({ agent, session, question, onAnswered }: { agent: string; session: string; question: SessionQuestion; onAnswered: () => void }) {
  if (question.async) return <AsyncQuestionCard agent={agent} session={session} question={question} onAnswered={onAnswered} />;
  return <WaitingQuestionCard agent={agent} session={session} question={question} onAnswered={onAnswered} />;
}

function WaitingQuestionCard({ agent, session, question, onAnswered }: { agent: string; session: string; question: SessionQuestion; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A question with several answers allowed: click to pick, then send.
  const [picked, setPicked] = useState<string[]>([]);
  const answer = async (labels: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerSessionQuestion(agent, session, question.id, labels);
      onAnswered();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="question-card"
      data-testid="question-card"
      role="group"
      aria-label={question.header ?? 'Question'}
      style={{
        margin: '6px 12px',
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--warn)',
        background: 'color-mix(in srgb, var(--warn) 9%, var(--bg-2))',
        color: 'var(--text-0)',
        fontSize: 12.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--warn)', fontWeight: 600, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        <ShieldQuestion size={14} className="icon-inline" /> {question.header ?? 'Question'}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-2)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }} title="Without an answer the safest option is taken">
          waits {remaining(question.expiresAt)}
        </span>
      </div>
      <div style={{ lineHeight: 1.45, wordBreak: 'break-word' }}>{question.question}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {question.options.map((o) => {
          const t = tone(o.description);
          const on = picked.includes(o.label);
          const note = o.description && !KINDS.has(o.description) ? o.description : null;
          return (
            <button
              key={o.label}
              type="button"
              disabled={busy}
              aria-pressed={question.multiple ? on : undefined}
              data-testid={`question-option-${o.label}`}
              onClick={() => (question.multiple ? setPicked((p) => (on ? p.filter((x) => x !== o.label) : [...p, o.label])) : void answer([o.label]))}
              style={{
                padding: '5px 12px',
                borderRadius: 6,
                fontSize: 12,
                textAlign: 'left',
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
                border: `1px solid ${on ? 'var(--accent)' : t === 'allow' ? 'var(--ok)' : t === 'reject' ? 'var(--danger)' : 'var(--line-2)'}`,
                background: on
                  ? 'color-mix(in srgb, var(--accent) 16%, transparent)'
                  : t === 'allow'
                    ? 'color-mix(in srgb, var(--ok) 14%, transparent)'
                    : t === 'reject'
                      ? 'color-mix(in srgb, var(--danger) 12%, transparent)'
                      : 'var(--bg-3)',
                color: 'var(--text-0)',
              }}
            >
              <span>{o.label}</span>
              {note && <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{note}</span>}
            </button>
          );
        })}
      </div>
      {question.multiple && (
        <button
          type="button"
          data-testid="question-send"
          disabled={busy || picked.length === 0}
          onClick={() => void answer(picked)}
          style={{ alignSelf: 'flex-start', padding: '5px 14px', borderRadius: 6, fontSize: 12, border: 'none', background: 'var(--accent)', color: 'var(--bg-0)', cursor: 'pointer', opacity: busy || picked.length === 0 ? 0.5 : 1 }}
        >
          Send{picked.length > 0 ? ` (${picked.length})` : ''}
        </button>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 11.5 }}>{error}</div>}
    </div>
  );
}

const optionStyle = (on: boolean, busy: boolean): React.CSSProperties => ({
  padding: '5px 12px',
  borderRadius: 6,
  fontSize: 12,
  textAlign: 'left',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  cursor: busy ? 'default' : 'pointer',
  opacity: busy ? 0.6 : 1,
  border: `1px solid ${on ? 'var(--accent)' : 'var(--line-2)'}`,
  background: on ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--bg-3)',
  color: 'var(--text-0)',
});

/** A question that does not wait: one or several, each with options
 *  (or a line for your own words). The answer goes out as your next
 *  message. */
function AsyncQuestionCard({ agent, session, question, onAnswered }: { agent: string; session: string; question: SessionQuestion; onAnswered: () => void }) {
  const parts = questionParts(question);
  const oneClick = answersOnClick(question);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[][]>(() => parts.map(() => []));
  const [texts, setTexts] = useState<string[]>(() => parts.map(() => ''));
  const send = async (body: NonNullable<ReturnType<typeof buildAnswer>>) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerSessionQuestion(agent, session, question.id, body);
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
    <div
      className="question-card"
      data-testid="question-card"
      data-async="true"
      role="group"
      aria-label={question.header ?? 'Question'}
      style={{
        margin: '6px 12px',
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--accent)',
        background: 'color-mix(in srgb, var(--accent) 8%, var(--bg-2))',
        color: 'var(--text-0)',
        fontSize: 12.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', fontWeight: 600, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        <MessageCircleQuestion size={14} className="icon-inline" /> {question.header ?? (parts.length > 1 ? `${parts.length} questions` : 'Question')}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-2)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>answer any time</span>
      </div>
      {parts.map((p, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ lineHeight: 1.45, wordBreak: 'break-word' }}>{p.question}</div>
          {p.options.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {p.options.map((o) => {
                const on = (picks[i] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={busy}
                    aria-pressed={oneClick ? undefined : on}
                    data-testid={`question-option-${o.label}`}
                    onClick={() => pick(i, o.label, p.multiple)}
                    style={optionStyle(on, busy)}
                  >
                    <span>{o.label}</span>
                    {o.description && <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{o.description}</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <input
              type="text"
              value={texts[i] ?? ''}
              disabled={busy}
              placeholder="Your answer"
              data-testid={`question-text-${i}`}
              onChange={(e) => setTexts((all) => all.map((t, j) => (j === i ? e.target.value : t)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && body) void send(body);
              }}
              style={{ padding: '5px 8px', borderRadius: 6, fontSize: 12, border: '1px solid var(--line-2)', background: 'var(--bg-1)', color: 'var(--text-0)' }}
            />
          )}
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {!oneClick && (
          <button
            type="button"
            data-testid="question-send"
            disabled={busy || !body}
            onClick={() => body && void send(body)}
            style={{ padding: '5px 14px', borderRadius: 6, fontSize: 12, border: 'none', background: 'var(--accent)', color: 'var(--bg-0)', cursor: 'pointer', opacity: busy || !body ? 0.5 : 1 }}
          >
            Send
          </button>
        )}
        <span style={{ color: 'var(--text-2)', fontSize: 11.5 }}>or write your own answer below</span>
      </div>
      {error && <div style={{ color: 'var(--danger)', fontSize: 11.5 }}>{error}</div>}
    </div>
  );
}
