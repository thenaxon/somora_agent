import { resolveSessionId, sessionMetaStore } from '../storage/sessions.ts';
import { loadPersona } from '../persona/loader.ts';
import { BrowserOpError } from './service.ts';

/** Browser callbacks must never materialize an arbitrary slug as a JSONL id. */
export async function resolveBrowserSession(agent: string, ref: string): Promise<string> {
  if (!(await loadPersona(agent))) throw new BrowserOpError('BROWSER_NOT_ALLOWED', 'agent no longer exists');
  const session = await resolveSessionId(agent, ref);
  if (!session) throw new BrowserOpError('BROWSER_ACTION_FAILED', `session '${ref}' not found — create it first`);
  const meta = await sessionMetaStore.get(agent, session);
  if (meta.archived === true || session.endsWith('-archive')) {
    throw new BrowserOpError('BROWSER_ACTION_FAILED', `session '${session}' is archived — restore it before continuing`);
  }
  return session;
}
