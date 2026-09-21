// What an exec result may carry back to the model.
//
// exec captures up to 256 KB per stream — but a tool result is capped
// again by the registry (100 000 JSON chars by default). A sync result
// above that was replaced wholesale by a `{truncated, preview: "<the
// JSON, cut mid-string>"}` blob: stdout arrived as an escaped fragment
// inside a string, exit code and `truncated` flag gone with it. 11 exec
// results hit that in the live logs of 2026-09 alone, and the tool's
// own description ("256 KB per stream") described a size no result
// could ever have. One agent was handed half a web page and wrote the
// other half itself (report 2026-09-14).
//
// So exec fits its own output, in a way that keeps the result a result:
// head AND tail of each stream survive (a command's last lines are
// usually the ones that matter), the cut is marked where it happens,
// `truncated` is true, and the hint says how much is missing.

/** Chars of stdout+stderr a sync result may carry. Leaves headroom
 *  under the registry's 100 000-char JSON cap for escaping (a newline
 *  is two chars in JSON) and the envelope. */
export const EXEC_RESULT_TEXT_BUDGET = 60_000;

export interface FittedOutput {
  stdout: string;
  stderr: string;
  /** True when either stream was shortened here. */
  shortened: boolean;
  /** Ready-made hint, only when shortened. */
  hint?: string;
}

function middleOut(text: string, budget: number, stream: string): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  const dropped = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n\n[… ${dropped} chars of ${stream} omitted here — output shortened by somora, NOT the end of the command's output …]\n\n` +
    text.slice(text.length - tail)
  );
}

/** JSON chars the two streams may take in the serialized result —
 *  what the registry cap actually measures. */
const EXEC_RESULT_JSON_BUDGET = 90_000;

const jsonChars = (a: string, b: string): number => JSON.stringify(a).length + JSON.stringify(b).length;

export function fitExecOutput(stdout: string, stderr: string, budget = EXEC_RESULT_TEXT_BUDGET): FittedOutput {
  // Text that escapes badly (control bytes are 6 JSON chars each) can
  // pass the char budget and still blow the registry's JSON cap, which
  // would bring the preview blob back. Tighten until it fits.
  let fitted = fitOnce(stdout, stderr, budget);
  let b = budget;
  while (jsonChars(fitted.stdout, fitted.stderr) > EXEC_RESULT_JSON_BUDGET && b > 2_000) {
    b = Math.floor(b * 0.7);
    fitted = fitOnce(stdout, stderr, b);
  }
  return fitted;
}

function fitOnce(stdout: string, stderr: string, budget: number): FittedOutput {
  if (stdout.length + stderr.length <= budget) return { stdout, stderr, shortened: false };
  // stderr is usually small and usually the part that explains a
  // failure: give it up to a quarter, the rest to stdout; whatever one
  // stream does not need goes to the other.
  const stderrShare = Math.min(stderr.length, Math.floor(budget / 4));
  const stdoutShare = Math.min(stdout.length, budget - stderrShare);
  const stderrBudget = Math.min(stderr.length, budget - stdoutShare);
  const total = stdout.length + stderr.length;
  return {
    stdout: middleOut(stdout, stdoutShare, 'stdout'),
    stderr: middleOut(stderr, stderrBudget, 'stderr'),
    shortened: true,
    hint:
      `Output was ${total} chars; this result carries the first and last part of each stream ` +
      `(about ${budget} chars) with the cut marked in the text. Do not guess what was omitted: ` +
      `redirect the command's output to a file and read it with file_read offset/limit, or narrow ` +
      `the command (grep, head, tail, jq).`,
  };
}
