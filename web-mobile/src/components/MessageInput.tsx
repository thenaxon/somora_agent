// Text input at the bottom of the screen with a circular send button.
// Mic-button is a placeholder for Phase 2 (STT). Auto-grows up to
// max-height; on submit clears the textarea and posts via the
// provided onSend (which calls /chat/send under the hood).

import { useRef, useState } from 'react';

interface Props {
  agent: string;
  onSend: (text: string) => Promise<void>;
}

export function MessageInput({ agent, onSend }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !sending;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText('');
      if (ref.current) ref.current.style.height = 'auto';
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter without Shift = send. Shift+Enter inserts newline. Soft-
    // keyboards on iOS/Android send Enter as a literal newline by
    // default; we override that here so mobile feels like a messenger.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    setText(e.currentTarget.value);
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  return (
    <div className="input-bar">
      <button
        type="button"
        className="input-btn"
        disabled
        title="Stimme kommt mit Phase 2"
        aria-label="Stimme (kommt in einer späteren Version)"
      >
        🎙️
      </button>
      <textarea
        ref={ref}
        className="input-textarea"
        rows={1}
        placeholder={`Nachricht an ${agent}…`}
        value={text}
        onChange={onInput}
        onKeyDown={onKeyDown}
        autoCapitalize="sentences"
        autoCorrect="on"
        autoComplete="off"
        spellCheck
      />
      <button
        type="button"
        className="input-btn primary"
        disabled={!canSend}
        onClick={submit}
        aria-label="Senden"
      >
        ➤
      </button>
    </div>
  );
}
