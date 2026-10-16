// An open question of the session, as a card above the input: an external
// agent asking "may I run this?" (docs/external-agents.md). One button per
// option; the turn waits until one is clicked or the time runs out (then
// the server picks the safest option). The builder keeps its own panel.

import { useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { api, type SessionQuestion } from '../lib/api';

function remaining(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
}

/** Tone of a button by the option's kind (sent as its description). */
function tone(kind: string | undefined): 'allow' | 'reject' | 'plain' {
  if (!kind) return 'plain';
  if (kind.startsWith('allow')) return 'allow';
  if (kind.startsWith('reject')) return 'reject';
  return 'plain';
}

export function QuestionCard({ agent, session, question, onAnswered }: { agent: string; session: string; question: SessionQuestion; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (label: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerSessionQuestion(agent, session, question.id, [label]);
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
          return (
            <button
              key={o.label}
              type="button"
              disabled={busy}
              data-testid={`question-option-${o.label}`}
              onClick={() => void answer(o.label)}
              style={{
                padding: '5px 12px',
                borderRadius: 6,
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
                border: `1px solid ${t === 'allow' ? 'var(--ok)' : t === 'reject' ? 'var(--danger)' : 'var(--line-2)'}`,
                background: t === 'allow' ? 'color-mix(in srgb, var(--ok) 14%, transparent)' : t === 'reject' ? 'color-mix(in srgb, var(--danger) 12%, transparent)' : 'var(--bg-3)',
                color: 'var(--text-0)',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {error && <div style={{ color: 'var(--danger)', fontSize: 11.5 }}>{error}</div>}
    </div>
  );
}
