// After a builder's write: ask the server for the language server's
// verdict on the file and put it on the tool result. Over loopback HTTP
// so the MCP child (claude-cli, codex-cli) gets the same as the
// in-process loop — the servers live in the main process only.
//
// Never throws, never delays a chat agent: the route answers "not a
// builder" at once, and a missing server or a slow verdict is null.

import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import { logger } from '../../server/logger.ts';
import type { ToolContext } from '../types.ts';
import { loadPersona } from '../../persona/loader.ts';

export interface LspAddendum {
  errors: string[];
  errors_in_other_files?: Record<string, string[]>;
  language_server: string;
  hint: string;
}

function baseUrl(): string {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
}

/** Only a builder session pays the round trip. */
async function eligible(ctx: ToolContext): Promise<boolean> {
  if (!ctx.session) return false;
  const persona = await loadPersona(ctx.agent);
  return persona?.kind === 'builder';
}

export async function lspAfterWrite(ctx: ToolContext, absolute: string): Promise<LspAddendum | null> {
  if (!(await eligible(ctx))) return null;
  try {
    const res = await loopbackFetch(`${baseUrl()}/lsp/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: ctx.agent, session: ctx.session, path: absolute }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { diagnostics: { server: string; errors: string[]; errors_in_other_files: Record<string, string[]> } | null };
    const d = data.diagnostics;
    if (!d) return null;
    const others = Object.keys(d.errors_in_other_files).length > 0 ? d.errors_in_other_files : undefined;
    if (d.errors.length === 0 && !others) return { errors: [], language_server: d.server, hint: 'No errors in this file.' };
    return {
      errors: d.errors,
      ...(others ? { errors_in_other_files: others } : {}),
      language_server: d.server,
      hint: d.errors.length > 0 ? 'Fix these before moving on — they are the compiler\'s word, not a guess.' : 'This change broke other files — fix them before moving on.',
    };
  } catch (err) {
    const c = classifyFetchError(err);
    logger.debug({ msg: 'lsp.hook_failed', agent: ctx.agent, err: c.message });
    return null;
  }
}

/** Pre-warm the server for a file a builder reads (fire and forget). */
export function lspTouch(ctx: ToolContext, absolute: string): void {
  void eligible(ctx).then((ok) => {
    if (!ok) return;
    return loopbackFetch(`${baseUrl()}/lsp/diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: ctx.agent, session: ctx.session, path: absolute, touch: true }),
    });
  }).catch(() => undefined);
}
