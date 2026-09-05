// Inline reasoning splitter for openai-compatible backends that do NOT
// separate thinking into `reasoning_content` but leave it in `content`
// with `<think>…</think>` markers.
//
// Two shapes occur in the wild:
//   `<think>…reasoning…</think>answer`            — plain inline block
//   `…reasoning…</think>answer`                   — DeepSeek V4 on SGLang
//     without a reasoning parser: the chat template prefills `<think>`
//     inside the PROMPT, so the model output starts with the reasoning
//     and only the closing tag is present (2026-09-03 report: a
//     subagent `result` began with ~2.5k chars of reasoning and a bare
//     `</think>` before the actual table).
//
// The chat path had the same leak; it just went unnoticed because a human
// reader skips past it. A parent agent consuming a sub's `result` does
// not — it is context garbage and a parsing hazard.

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

export interface InlineThinkSplit {
  /** Reasoning text (without the tags), '' when there was none. */
  thinking: string;
  /** Content after the closing tag (or the whole text when no block). */
  content: string;
}

/**
 * Split one inline think block off the START of `text`. Only the first
 * closing tag counts; a `<think>` that appears after the closing tag
 * (or a closing tag deep inside genuine content) is left alone — the
 * block must begin at offset 0 (optionally with the opening tag) to
 * qualify, so ordinary prose that merely mentions the tags survives.
 */
export function splitInlineThink(text: string): InlineThinkSplit {
  const close = text.indexOf(THINK_CLOSE);
  if (close < 0) return { thinking: '', content: text };
  let head = text.slice(0, close);
  const trimmedHead = head.trimStart();
  const hasOpen = trimmedHead.startsWith(THINK_OPEN);
  if (hasOpen) {
    head = trimmedHead.slice(THINK_OPEN.length);
  } else if (trimmedHead.includes(THINK_OPEN)) {
    // An opening tag that is NOT at the start means the text before it
    // is real content; don't treat the prefix as reasoning.
    return { thinking: '', content: text };
  }
  return {
    thinking: head.trim(),
    content: text.slice(close + THINK_CLOSE.length).replace(/^\s+/, ''),
  };
}

/** True when `text` still has an unclosed inline think block open at its
 *  start — i.e. it begins with `<think>` and no closing tag yet. Used by
 *  the streaming path to hold back deltas that are known to be reasoning. */
export function insideOpenThink(text: string): boolean {
  return text.trimStart().startsWith(THINK_OPEN) && !text.includes(THINK_CLOSE);
}
