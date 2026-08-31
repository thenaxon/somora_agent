// Input row at the bottom: paperclip (attachments) + textarea + mic
// (STT) + send. Attachments are uploaded eagerly to /attachments,
// staged as refs, and bundled into the chat-send body. Voice transcript
// lands in the textarea for the user to review/edit before send (no
// auto-send — explicit UX decision).

import { useEffect, useRef, useState } from 'react';
import { AttachmentPicker, type AttachmentRef } from './AttachmentPicker';
import { MicButton } from './MicButton';

interface Props {
  agent: string;
  onSend: (
    text: string,
    attachments: AttachmentRef[],
    voice?: { inputModality?: 'voice'; autoPlayRequested?: boolean },
  ) => Promise<void>;
  /** When true and the current draft came from STT, the send call
   *  flags input_modality=voice + auto_play_requested=true. */
  autoPlayEnabled: boolean;
  /** True while the agent is mid-turn. Primary button becomes Stop. */
  streaming?: boolean;
  /** Abort the in-flight turn. Wired while streaming. */
  onAbort?: () => void;
  /** Text handed back from a recalled (dequeued) message. `nonce`
   *  changes per recall so the same text can be injected twice; the
   *  draft is REPLACED, not appended — the user is editing that
   *  message, not adding to another. */
  draftInject?: { text: string; nonce: number } | null;
}

export function MessageInput({
  agent,
  onSend,
  autoPlayEnabled,
  streaming = false,
  onAbort,
  draftInject,
}: Props) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!draftInject) return;
    setText(draftInject.text);
    setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftInject?.nonce]);
  const [staged, setStaged] = useState<AttachmentRef[]>([]);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Tracks whether the CURRENT draft was produced by STT. Reset on
  // send (consumed) — fresh typing after that no longer flags voice.
  const fromMicRef = useRef<boolean>(false);

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
    const voiceFlag = fromMicRef.current;
    fromMicRef.current = false; // consume on send
    // Optimistically clear the input so the user sees the bubble has
    // gone out. If the send throws, we restore.
    setText('');
    setStaged([]);
    if (ref.current) ref.current.style.height = 'auto';
    const voice = voiceFlag
      ? { inputModality: 'voice' as const, autoPlayRequested: autoPlayEnabled }
      : undefined;
    try {
      await onSend(payloadText, payloadAttachments, voice);
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
    // Send stays available while streaming (button AND Enter) — sends
    // mid-turn enqueue via the server session queue.
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
    fromMicRef.current = true;
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
          placeholder={`Message ${agent}…`}
          value={text}
          onChange={onInput}
          onKeyDown={onKeyDown}
          autoCapitalize="sentences"
          autoCorrect="on"
          autoComplete="off"
          spellCheck
        />
        {/* Stop is ADDITIVE next to Send while streaming — touch has
         *  no Enter key, so replacing Send would make queued sends
         *  impossible mid-turn. Send stays live; taps enqueue via the
         *  server session queue. */}
        {streaming && (
          <button
            type="button"
            className="input-btn primary stop"
            onClick={() => onAbort?.()}
            aria-label="Stop generating"
            title="Stop generating"
          >
            <StopIcon />
          </button>
        )}
        <button
          type="button"
          className="input-btn primary"
          disabled={!canSend}
          onClick={submit}
          aria-label="Send"
          title="Send"
        >
          ➤
        </button>
      </div>
    </>
  );
}

// Filled stop square — same visual language as the former bubble Stop.
// Inline SVG keeps the mobile "no lucide-react" rule.
function StopIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}
