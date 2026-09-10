// What actually goes on the wire, measured before it is sent.
//
// somora sized the context once per turn, from user and assistant text
// only (compaction/policy.ts). That misses everything a working turn is
// made of: tool schemas, tool results, images. On 2026-09-10 a turn
// started at an estimated 58,583 tokens, ran eighteen tool calls, and
// the backend counted more than 507,905 input tokens against a 524,288
// window. The turn died on a raw HTTP 400 and its work was lost.
//
// Two pieces live here. `estimateRequestTokens` measures one outgoing
// request, and `trimToolResults` makes room inside a running turn by
// shortening the OLDEST tool results — never by dropping a message.
// Dropping is what a naive fix would do, and it breaks the conversation:
// an assistant message with `tool_calls` and no matching `tool` reply is
// rejected by every OpenAI-compatible backend. Shortening keeps the pair
// and keeps the model's own record of what it already did, which is what
// stops it from running the same tool again.

/** Structural view of an OpenAI chat message; the engine's own type is wider. */
export interface BudgetMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/** The 4-chars-per-token heuristic the compaction policy already uses. */
const CHARS_PER_TOKEN = 4;
/** Per message: role, separators, the wrapper the provider adds. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** One image block, whatever its base64 length. Anthropic and OpenAI
 *  both land near this for a full-viewport screenshot. */
const IMAGE_TOKENS = 1_300;
/** Output room when the model itself declares no `maxTokens`. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 4_096;

function textTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Tokens for one message's content, images counted as images. */
function contentTokens(content: unknown): number {
  if (content === null || content === undefined) return 0;
  if (typeof content === 'string') return textTokens(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content as Array<Record<string, unknown>>) {
      const type = typeof part?.type === 'string' ? part.type : '';
      if (type === 'image_url' || type === 'image' || type === 'input_image') {
        // A base64 data URL is megabytes of characters and nothing like
        // that many tokens. Counting its length would make every image
        // look like the whole context window.
        total += IMAGE_TOKENS;
        continue;
      }
      if (typeof part?.text === 'string') {
        total += textTokens(part.text);
        continue;
      }
      total += textTokens(JSON.stringify(part ?? ''));
    }
    return total;
  }
  return textTokens(JSON.stringify(content));
}

/**
 * Estimate the prompt for ONE request: every message plus the tool
 * schemas, which travel with each request and are easy to forget — a
 * large toolset is tens of thousands of tokens on its own.
 */
export function estimateRequestTokens(messages: readonly BudgetMessage[], tools?: unknown): number {
  let total = tools ? textTokens(JSON.stringify(tools)) : 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    total += contentTokens(m.content);
    if (m.tool_calls) total += textTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

export interface BudgetInput {
  contextWindow: number;
  /** The model's own output cap, when it declares one. */
  maxOutputTokens?: number;
  /** Fraction of the window kept free for estimation error. */
  safetyRatio?: number;
}

/**
 * How much prompt this model can actually take: the window minus the
 * answer it still has to write, minus a margin for the fact that a
 * character heuristic is not a tokenizer.
 */
export function promptBudget({ contextWindow, maxOutputTokens, safetyRatio = 0.05 }: BudgetInput): number {
  const reserve = maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  return Math.max(1, Math.floor(contextWindow - reserve - contextWindow * safetyRatio));
}

export interface TrimResult {
  messages: BudgetMessage[];
  /** Tool results shortened. */
  trimmed: number;
  /** Estimated tokens after trimming. */
  estimate: number;
  /** True when the request fits the budget now. */
  fits: boolean;
}

export function trimNotice(originalChars: number): string {
  return `[somora: this tool result (${originalChars} characters) was shortened to keep the conversation inside the model's context window. It already ran — do not run it again. Ask for the part you still need.]`;
}

export function truncateNotice(originalChars: number, keptChars: number): string {
  return `\n[somora: cut here. This result was ${originalChars} characters; the first ${keptChars} are above, the rest did not fit the model's context window. It already ran — do not run it again.]`;
}

/**
 * Shorten the oldest tool results until the request fits.
 *
 * `keepRecent` results stay untouched, because the newest results are
 * what the model is reasoning about right now; shortening those would
 * make it repeat the call. Assistant/user text and the tool_call
 * structure are never touched, so every pairing survives.
 */
export function trimToolResults(
  messages: readonly BudgetMessage[],
  args: { budget: number; tools?: unknown; keepRecent?: number },
): TrimResult {
  const keepRecent = args.keepRecent ?? 4;
  const out = messages.map((m) => ({ ...m }));
  const toolIdx = out.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  // Oldest first. The recent ones are only touched when the old ones
  // were not enough, and the very last result is never touched at all —
  // that is the one the model is about to reason about, and shortening
  // it is how you get the same tool called a second time.
  const oldest = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  const recent = toolIdx.slice(Math.max(0, toolIdx.length - keepRecent), Math.max(0, toolIdx.length - 1));
  const order = [...oldest, ...recent];
  let estimate = estimateRequestTokens(out, args.tools);
  let trimmed = 0;
  for (const i of order) {
    if (estimate <= args.budget) break;
    const msg = out[i]!;
    const before = contentTokens(msg.content);
    const chars = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content ?? '').length;
    const notice = trimNotice(chars);
    const after = textTokens(notice);
    if (after >= before) continue; // already short: nothing to win
    msg.content = notice;
    estimate -= before - after;
    trimmed++;
  }
  // Last resort: the newest result alone is bigger than the budget.
  // Cutting it keeps the beginning, which is where a file, a page or a
  // listing says what it is — and it keeps the turn alive. Refusing here
  // would end a turn whose tools have already run.
  if (estimate > args.budget && toolIdx.length > 0) {
    const i = toolIdx.at(-1)!;
    const msg = out[i]!;
    if (typeof msg.content === 'string') {
      const before = contentTokens(msg.content);
      const room = args.budget - (estimate - before);
      const keepChars = Math.max(0, room * CHARS_PER_TOKEN - 400);
      if (keepChars < msg.content.length) {
        const head = msg.content.slice(0, keepChars);
        msg.content = head + truncateNotice(msg.content.length, keepChars);
        estimate = estimate - before + contentTokens(msg.content);
        trimmed++;
      }
    }
  }
  return { messages: out, trimmed, estimate, fits: estimate <= args.budget };
}
