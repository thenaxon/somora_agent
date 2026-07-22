// Sanitize assistant_message text against model-emitted XML-style
// tool-call markup.
//
// Background — 2026-05-17 Rene saw a "wall of text" with literal
// `<tool_call>{"name": "...", ...}</tool_call>` and
// `<tool_response>...</tool_response>` blocks in the chat UI. Lisa
// originally hypothesised that the <context-from-other-engines>
// replay block was leaking; verifying against src/engine/replay.ts
// proved that path structurally cannot inject tool-call XML (replays
// only carry user/assistant text pairs, never tool events).
//
// The real source is the model itself: some engines / models / tool
// configurations make the LLM hallucinate text-format tool calls in
// its assistant output — it writes the XML-style markup it learned
// from training data instead of going through the engine's native
// tool_use channel. The assistant_message.text then carries the raw
// JSON-in-XML, which react-markdown's HTML-sanitizer strips the
// outer tags from but leaves the JSON body sitting in the chat
// bubble as a wall of text.
//
// This module normalises that. On match:
//   1. Each <tool_call>…</tool_call> and <tool_response>…</tool_response>
//      pair is collapsed to a one-line placeholder noting the
//      hallucination + the tool name (parsed best-effort from the
//      JSON body).
//   2. The number of matches is returned so the caller can warn-log.
//
// Run this on the FINAL assistant_message.text, not on assistant_delta
// events — XML boundaries can split across delta chunks. The chat-
// bubble flips from streamed deltas to final-message text on
// turn_end, so a small partial-XML flicker during streaming is fine.

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const TOOL_RESPONSE_RE = /<tool_response>[\s\S]*?<\/tool_response>/gi;
// `<somora-tool-log>` is OUR marker for the tool-execution record that
// history-rebuild injects (src/engine/tool-trace.ts). It belongs to the
// system and only ever appears in user-role content. A model emitting it
// in its own answer is fabricating tool work — 2026-07-22, first rollout
// of the feature put the block in the assistant role and models promptly
// started writing their own, complete with invented commands and
// outputs, then reasoning on top of them. Same class as the two above:
// anything the assistant channel contains, the model learns to reproduce.
const SOMORA_TOOL_LOG_RE = /<somora-tool-log>[\s\S]*?<\/somora-tool-log>/gi;
// Unclosed variant — a truncated/streamed fabrication leaves a dangling
// opener that would otherwise sit in the bubble as raw text.
const SOMORA_TOOL_LOG_OPEN_RE = /<somora-tool-log>[\s\S]*$/i;

export interface SanitizeResult {
  text: string;
  matches: number;
}

/** Try to pull a `"name": "<tool>"` field out of a tool_call body. */
function extractToolName(body: string): string | null {
  const m = body.match(/"name"\s*:\s*"([^"]+)"/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Strip + replace hallucinated `<tool_call>…</tool_call>` and
 * `<tool_response>…</tool_response>` blocks in assistant text.
 *
 * Always safe to call: when no markers are present the original
 * string is returned unchanged and `matches` is 0. Caller should
 * warn-log on `matches > 0` so we can track which engines/models
 * trigger this in production.
 */
export function sanitizeAssistantText(input: string): SanitizeResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { text: input, matches: 0 };
  }
  // Cheap pre-check — both regexes scan the whole string otherwise,
  // and assistant texts can be huge (tens of KB).
  if (
    !input.includes('<tool_call>') &&
    !input.includes('<tool_response>') &&
    !input.includes('<somora-tool-log>')
  ) {
    return { text: input, matches: 0 };
  }

  let matches = 0;

  let out = input.replace(TOOL_CALL_RE, (_full, body: string) => {
    matches += 1;
    const name = extractToolName(body) ?? 'unknown';
    return `[hallucinated tool-call (${name}): model emitted text-format XML instead of structured tool_use — content elided]`;
  });

  out = out.replace(TOOL_RESPONSE_RE, () => {
    matches += 1;
    return `[hallucinated tool-response: model emitted text-format XML instead of structured tool_result — content elided]`;
  });

  out = out.replace(SOMORA_TOOL_LOG_RE, () => {
    matches += 1;
    return `[fabricated tool-log: model wrote somora's own tool-execution marker instead of calling tools — no tools actually ran, content elided]`;
  });
  // Whatever is left after closed-pair removal can only be a dangling
  // opener; drop it and everything after it.
  if (out.includes('<somora-tool-log>')) {
    matches += 1;
    out = out.replace(
      SOMORA_TOOL_LOG_OPEN_RE,
      `[fabricated tool-log (unterminated): model wrote somora's own tool-execution marker — no tools actually ran, content elided]`,
    );
  }

  return { text: out, matches };
}
