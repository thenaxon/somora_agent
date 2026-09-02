// Markdown chunking. Splits content into ~targetTokens chunks with
// overlapTokens of overlap between adjacent chunks. Token estimate is the
// project-wide 4-chars/token heuristic.
//
// We chunk by markdown structure first (split on blank lines, then on
// heading boundaries), then pack chunks up to the target size. Overlap is
// done as a sliding window over the *paragraph list*, not character-level —
// keeps chunks readable.
//
// Frontmatter (--- ... ---) at the top is stripped before chunking; metadata
// from the frontmatter is the caller's job.

export interface MarkdownChunk {
  /** Concatenated paragraph text. */
  text: string;
  /** 1-based line numbers (inclusive). */
  startLine: number;
  endLine: number;
}

interface Paragraph {
  text: string;
  startLine: number;
  endLine: number;
}

/** Strip leading frontmatter block if present. Returns body + offset (line count consumed). */
export function stripFrontmatter(input: string): { body: string; bodyStartLine: number } {
  if (!input.startsWith('---')) return { body: input, bodyStartLine: 1 };
  const lines = input.split('\n');
  if (lines.length < 2) return { body: input, bodyStartLine: 1 };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { body: input, bodyStartLine: 1 };
  return {
    body: lines.slice(endIdx + 1).join('\n'),
    bodyStartLine: endIdx + 2, // 1-based, line after closing ---
  };
}

function estimateTokens(text: string): number {
  // 4 chars/token is the project-wide heuristic. Code is denser, prose
  // looser, but it's close enough for chunk-size budgeting.
  return Math.ceil(text.length / 4);
}

function splitParagraphs(body: string, lineOffset: number): Paragraph[] {
  const lines = body.split('\n');
  const paragraphs: Paragraph[] = [];
  let buf: string[] = [];
  let start = -1;
  const flush = (endIdx: number) => {
    if (buf.length === 0) return;
    const text = buf.join('\n').trim();
    if (text.length > 0) {
      paragraphs.push({
        text,
        startLine: start + lineOffset,
        endLine: endIdx + lineOffset,
      });
    }
    buf = [];
    start = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      flush(i - 1);
    } else {
      if (start < 0) start = i;
      buf.push(line);
    }
  }
  flush(lines.length - 1);
  return paragraphs;
}

export interface ChunkOptions {
  targetTokens: number;
  overlapTokens: number;
}

/**
 * Pack paragraphs into chunks of ~targetTokens. Overlap is implemented at
 * paragraph granularity: each chunk starts with the trailing paragraphs of
 * the previous chunk that together cover overlapTokens.
 */
export function chunkMarkdown(
  input: string,
  opts: ChunkOptions = { targetTokens: 400, overlapTokens: 80 },
): MarkdownChunk[] {
  const { body, bodyStartLine } = stripFrontmatter(input);
  const paragraphs = splitParagraphs(body, bodyStartLine);
  if (paragraphs.length === 0) return [];

  const chunks: MarkdownChunk[] = [];
  let current: Paragraph[] = [];
  let currentTokens = 0;

  const pushChunk = () => {
    if (current.length === 0) return;
    const text = current.map((p) => p.text).join('\n\n');
    chunks.push({
      text,
      startLine: current[0]!.startLine,
      endLine: current[current.length - 1]!.endLine,
    });
  };

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para.text);

    // If a single paragraph exceeds the target, it becomes its own chunk —
    // we don't split mid-paragraph (would corrupt code blocks, lists, etc.)
    if (paraTokens >= opts.targetTokens && current.length === 0) {
      current.push(para);
      pushChunk();
      // An oversized paragraph is already a complete standalone chunk.
      // Do NOT carry it forward as overlap: buildOverlap would return the
      // whole paragraph (it alone exceeds overlapTokens), leaving `current`
      // at >= target — so the very next paragraph would immediately
      // re-emit it as a byte-identical duplicate chunk AND glue the entire
      // giant block onto the following chunk. Start fresh instead; normal
      // (sub-target) paragraphs still get their tail overlap below.
      current = [];
      currentTokens = 0;
      continue;
    }

    if (currentTokens + paraTokens > opts.targetTokens && current.length > 0) {
      pushChunk();
      current = buildOverlap(current, opts.overlapTokens);
      currentTokens = current.reduce((s, p) => s + estimateTokens(p.text), 0);
    }
    current.push(para);
    currentTokens += paraTokens;
  }
  pushChunk();
  return chunks;
}

function buildOverlap(prev: Paragraph[], overlapTokens: number): Paragraph[] {
  if (overlapTokens <= 0) return [];
  const out: Paragraph[] = [];
  let acc = 0;
  for (let i = prev.length - 1; i >= 0; i--) {
    const p = prev[i]!;
    out.unshift(p);
    acc += estimateTokens(p.text);
    if (acc >= overlapTokens) break;
  }
  // The overlap must be a STRICT suffix of the previous chunk. When the
  // previous chunk is shorter than overlapTokens (a lone heading, a short
  // paragraph before a big one), the loop above hands back the whole
  // chunk — and the next chunk then starts at the same line and CONTAINS
  // the previous one. Observed live 2026-09-01: a 96-line wiki page
  // indexed as 17-18 ⊂ 17-33 and 35-60 ⊂ 35-68, and both halves of each
  // pair matched the same query, so the same text went into the prompt
  // twice. Dropping the first paragraph keeps the next chunk's start
  // strictly later; a single-paragraph chunk carries no overlap at all.
  if (out.length === prev.length) out.shift();
  return out;
}
