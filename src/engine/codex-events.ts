// Error extraction for `codex exec --json` streams.
//
// codex reports failures on STDOUT, as JSON events — stderr stays empty
// and the process exits 1. Measured 2026-08-31 (codex-cli 0.144.6) with
// an unsupported model name:
//
//   {"type":"item.completed","item":{"id":"item_0","type":"error",
//     "message":"Model metadata for `x` not found. Defaulting to …"}}
//   {"type":"turn.started"}
//   {"type":"error","message":"{\"type\":\"error\",\"status\":400,
//     \"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'x'
//     model is not supported when using Codex with a ChatGPT account.\"}}"}
//   {"type":"turn.failed","error":{"message":"…same JSON string…"}}
//
// A reader that only looks at stderr therefore sees "exit 1, stderr
// empty" — which is exactly how the compaction-worker crash reached us
// as an undiagnosable report (Donna/Luca, 2026-08-29). Both the engine
// adapter and the compaction summarizer feed their event stream through
// `codexStreamError` and keep what it returns for their failure message.

export interface CodexStreamEvent {
  type?: string;
  [k: string]: unknown;
}

/** Flatten codex's nested-JSON error message into one readable line:
 *  `HTTP 400 invalid_request_error: The 'x' model is not supported …`.
 *  Falls back to the raw string when it isn't the JSON envelope. */
export function flattenCodexErrorMessage(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('{')) return s;
  try {
    const doc = JSON.parse(s) as {
      status?: number;
      error?: { type?: string; message?: string };
      message?: string;
    };
    const inner = doc.error?.message ?? doc.message;
    if (!inner) return s;
    const parts: string[] = [];
    if (doc.status !== undefined) parts.push(`HTTP ${doc.status}`);
    if (doc.error?.type) parts.push(doc.error.type);
    return parts.length > 0 ? `${parts.join(' ')}: ${inner}` : inner;
  } catch {
    return s;
  }
}

/** The error text an event carries, or null for non-error events.
 *  `turn.failed` repeats the preceding `error` event's message; callers
 *  dedupe by keeping the message set. `item.completed` with an error
 *  item is codex's warning channel (e.g. unknown model metadata) — it
 *  is returned too, because it is often the first hint of WHY the
 *  turn then failed. */
export function codexStreamError(ev: CodexStreamEvent): string | null {
  if (ev.type === 'error' && typeof ev.message === 'string') {
    return flattenCodexErrorMessage(ev.message);
  }
  if (ev.type === 'turn.failed') {
    const err = ev.error as { message?: string } | undefined;
    if (err && typeof err.message === 'string') return flattenCodexErrorMessage(err.message);
    return 'turn.failed (no message)';
  }
  if (ev.type === 'item.completed') {
    const item = ev.item as { type?: string; message?: string } | undefined;
    if (item?.type === 'error' && typeof item.message === 'string') {
      return flattenCodexErrorMessage(item.message);
    }
  }
  return null;
}

/** Collects stream errors in order, deduped, and renders the failure
 *  detail for a message: stream errors first (they carry the cause),
 *  then stderr, then an explicit "nothing" so a log line never reads
 *  as an empty string again. */
export class CodexFailureDetail {
  private seen = new Set<string>();
  readonly errors: string[] = [];

  observe(ev: CodexStreamEvent): void {
    const e = codexStreamError(ev);
    if (e && !this.seen.has(e)) {
      this.seen.add(e);
      this.errors.push(e);
    }
  }

  /** One line for the user-facing error message. */
  render(stderr: string, max = 500): string {
    const stream = this.errors.join(' | ');
    const err = stderr.trim();
    if (stream && err) return `${stream} [stderr: ${err.slice(0, max)}]`.slice(0, max + 100);
    if (stream) return stream.slice(0, max);
    if (err) return err.slice(0, max);
    return '(no error output: stderr empty, no error event in the JSON stream)';
  }
}
