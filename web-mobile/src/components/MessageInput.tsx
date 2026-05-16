// Input row at the bottom: paperclip (attachments) + textarea + mic
// (STT) + send. Attachments are uploaded eagerly to /attachments,
// staged as refs, and bundled into the chat-send body. Voice transcript
// lands in the textarea for the user to review/edit before send (no
// auto-send — explicit UX decision).

import { useRef, useState } from 'react';
import { AttachmentPicker, type AttachmentRef } from './AttachmentPicker';
import { MicButton } from './MicButton';

interface Props {
  agent: string;
  onSend: (text: string, attachments: AttachmentRef[]) => Promise<void>;
}

export function MessageInput({ agent, onSend }: Props) {
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<AttachmentRef[]>([]);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  // Allow attachment-only sends (e.g. a single photo with no text) —
  // some agents handle that fine and it's the typical phone-snap-and-ask
  // flow followed by a voice note next turn.
  const canSend = (trimmed.length > 0 || staged.length > 0) && !sending;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    const payloadText = trimmed;
    const payloadAttachments = staged;
    // Optimistically clear the input so the user sees the bubble has
    // gone out. If the send throws, we restore.
    setText('');
    setStaged([]);
    if (ref.current) ref.current.style.height = 'auto';
    try {
      await onSend(payloadText, payloadAttachments);
    } catch (err) {
      // Restore state so the user can retry.
      setText(payloadText);
      setStaged(payloadAttachments);
      console.warn('[somora-mobile] send failed:', err);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  // Voice transcript handler: append to existing textarea content
  // (with a separating space) so multiple records can be stitched
  // together before send, and any text the user already typed isn't
  // lost. Caret position isn't preserved — for a phone keyboard that's
  // acceptable, and it auto-resizes the textarea on next input.
  const onTranscript = (transcript: string) => {
    setText((prev) => (prev ? `${prev} ${transcript}`.trim() : transcript));
    // Trigger height-recalc by focusing + dispatching an input event
    // shape; cleaner than tracking scrollHeight from outside.
    setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
      el.focus();
    }, 0);
  };

  return (
    <>
      <div className="input-bar">
        <AttachmentPicker
          staged={staged}
          onStage={(ref) => setStaged((cur) => [...cur, ref])}
          onRemove={(hash) =>
            setStaged((cur) => cur.filter((a) => a.hash !== hash))
          }
          disabled={sending}
        />
        <MicButton onTranscript={onTranscript} />
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
    </>
  );
}
