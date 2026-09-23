// Diagnostics as the model reads them: one line per error, the way a
// compiler prints it. Errors only — a small model given warnings chases
// them instead of the task (opencode does the same, max 20 per file).

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

export const MAX_ERRORS_PER_FILE = 10;
export const MAX_OTHER_FILES = 5;

export function formatError(d: LspDiagnostic): string {
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  const msg = d.message.replace(/\s+/g, ' ').trim();
  return `ERROR [${line}:${col}] ${msg}`;
}

/** Errors (severity 1) of one file as lines, capped, with a trailer. */
export function formatFileErrors(diags: readonly LspDiagnostic[], max = MAX_ERRORS_PER_FILE): string[] {
  const errors = diags.filter((d) => d.severity === 1 || d.severity === undefined);
  const lines = errors.slice(0, max).map(formatError);
  if (errors.length > max) lines.push(`… ${errors.length - max} more error(s) in this file`);
  return lines;
}
