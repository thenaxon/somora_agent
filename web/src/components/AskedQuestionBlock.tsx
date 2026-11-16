// A question an agent asked with ask_user, as it stays in the
// conversation once its card is answered (lib/asked-question.ts): the
// question, what it was about (details) and the options. Read-only; the
// answer is the person's own message right after it.

import { MessageCircleQuestion } from 'lucide-react';
import { AssistantMarkdown } from './AssistantMarkdown';
import type { AskedQuestion } from '../lib/asked-question';

export function AskedQuestionBlock({ asked }: { asked: AskedQuestion }) {
  return (
    <div
      className="asked-question"
      data-testid="asked-question"
      style={{
        margin: '4px 12px',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--line-2)',
        background: 'var(--bg-2)',
        color: 'var(--text-0)',
        fontSize: 12.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-2)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        <MessageCircleQuestion size={13} className="icon-inline" /> {asked.header ?? 'Question'}
      </div>
      <div style={{ lineHeight: 1.45, wordBreak: 'break-word', userSelect: 'text' }}>{asked.question}</div>
      {asked.details && (
        <div className="question-card-details">
          <AssistantMarkdown content={asked.details} />
        </div>
      )}
      {asked.options.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2, color: 'var(--text-1)', userSelect: 'text' }}>
          {asked.options.map((o) => (
            <li key={o.label}>
              <span style={{ color: 'var(--text-2)' }}>{asked.multiple ? '☐' : '○'}</span> <span style={{ fontWeight: 600 }}>{o.label}</span>
              {o.description && <span style={{ color: 'var(--text-2)' }}> · {o.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
