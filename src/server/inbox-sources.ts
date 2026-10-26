// Where inbox notices come from (src/server/inbox.ts).
//
// Two feeds, so the rest of somora needs no inbox calls of its own:
//
//   - the log: somora already writes a named line for every condition
//     worth a notice (a failed certificate renewal, a REM run that
//     failed, an engine that wants a new login) and for the success
//     that ends it. `inboxFromLog` maps those lines.
//   - a check every few minutes for states that have no single event:
//     a newer version, somora.ai's note, a broken config.yaml, a tool
//     server or a model that has been unreachable for a day.

import { createHash } from 'node:crypto';
import type { Inbox } from './inbox.ts';

/** REM runs / Deep attempts on the same note that must fail in a row
 *  before it is a notice; one failure is the log's business. */
export const FAIL_STREAK = 3;
/** A tool server or model gone this long is a notice. */
export const GONE_FOR_MS = 24 * 60 * 60 * 1000;

const LOGIN_ERROR = /\b401\b|unauthori[sz]ed|not logged in|please run \/login|\blogin (has )?expired|oauth token (has )?expired|invalid api key|authentication (failed|required)|re-?authenticate|credentials? (expired|invalid)/i;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// Which provider a turn runs on — an OpenAI compatible engine serves
// several providers, and a refused key belongs to one of them.
const turnProvider = new Map<string, string>();
function rememberTurn(turnId: string, provider: string): void {
  turnProvider.set(turnId, provider);
  if (turnProvider.size > 500) turnProvider.delete(turnProvider.keys().next().value!);
}

function loginKey(engine: string, provider: string): string {
  return engine === 'openai-compatible' ? `login:openai-compatible:${provider || 'unknown'}` : `login:${engine}`;
}

function loginTitle(engine: string, provider: string): string {
  if (engine === 'claude-cli') return 'Claude wants a new login';
  if (engine === 'codex-cli') return 'Codex wants a new login';
  if (engine === 'grok-cli') return 'Grok wants a new login';
  return `Provider ${provider || engine} refuses its key`;
}

function loginHint(engine: string, provider: string): string {
  if (engine === 'claude-cli') return 'Run `somora claude login` on the server.';
  if (engine === 'codex-cli') return 'Run `somora codex login` on the server.';
  if (engine === 'grok-cli') return 'Run `somora grok login` on the server.';
  return `Check \`providers.${provider || '<name>'}.apiKey\` in config.yaml.`;
}

/** A structured log line → raise, count or resolve. */
export function inboxFromLog(inbox: Inbox, line: Record<string, unknown>): void {
  const msg = str(line.msg);
  if (!msg) return;
  switch (msg) {
    // ── HTTPS certificate ──
    case 'server.tls.renew_failed':
      inbox.raise('tls', {
        kind: 'tls',
        level: 'important',
        title: 'The HTTPS certificate could not be renewed',
        text: `${line.days_left !== undefined && line.days_left !== null ? `It is valid for ${line.days_left} more day(s). ` : ''}${str(line.hint) || 'Run `tailscale cert` by hand to see why.'}${str(line.err) ? `\n\n${str(line.err)}` : ''}`,
      });
      return;
    case 'server.tls.expires_soon':
      inbox.raise('tls', {
        kind: 'tls',
        level: 'important',
        title: `The HTTPS certificate runs out in ${str(String(line.days_left ?? '?'))} day(s)`,
        text: str(line.hint),
      });
      return;
    case 'server.tls.reloaded':
      inbox.resolve('tls');
      return;

    // ── REM ──
    case 'dream.failed_chunks':
    case 'dream.rem.run_failed': {
      const agent = str(line.agent);
      if (!agent) return;
      const key = `rem:${agent}`;
      const o = inbox.observe(key);
      if (o.count >= FAIL_STREAK) {
        inbox.raise(key, {
          kind: 'dream',
          level: 'warning',
          title: `REM keeps failing for ${agent}`,
          text: `${o.count} REM runs in a row did not finish. The conversations stay waiting and are tried again, but nothing reaches the agent's memory until a run succeeds. Usually the REM model (or its backups) is unreachable — see rem.model and rem.fallback in ${agent}'s agent.yaml, or the central ones in config.yaml.`,
        });
      }
      return;
    }
    case 'dream.completed':
    case 'dream.completed_empty': {
      const agent = str(line.agent);
      if (agent) inbox.resolve(`rem:${agent}`);
      return;
    }

    // ── Deep ──
    case 'dream.deep.llm_call_failed': {
      const agent = str(line.agent);
      const slug = str(line.slug);
      if (!agent || !slug) return;
      const key = `deep:${agent}/${slug}`;
      const o = inbox.observe(key);
      if (o.count >= FAIL_STREAK) {
        inbox.raise(key, {
          kind: 'dream',
          level: 'warning',
          title: `Deep cannot place ${agent}'s note "${slug}"`,
          text: `The model call failed ${o.count} times in a row, so the note does not reach the wiki. Last error: ${str(line.err).slice(0, 300)}. A slow worker on a long page: raise wiki.deep.callTimeoutMs or add a wiki.deep.fallback.`,
        });
      }
      return;
    }
    case 'dream.deep.llm_response': {
      const agent = str(line.agent);
      const slug = str(line.slug);
      if (agent && slug && str(line.op) === 'deep') inbox.resolve(`deep:${agent}/${slug}`);
      const engine = str(line.engine);
      if (engine && engine !== 'openai-compatible') inbox.resolve(`login:${engine}`);
      return;
    }

    // ── Lucid ──
    case 'dream.lucid.failed':
      inbox.raise('lucid', {
        kind: 'dream',
        level: 'warning',
        title: 'The last Lucid run failed',
        text: `${str(line.error) || str(line.err) || 'See the server log (dream.lucid.failed).'} The next run comes at its usual time; the wiki window can start one now.`,
      });
      return;
    case 'dream.lucid.run_interrupted':
      inbox.raise('lucid', {
        kind: 'dream',
        level: 'info',
        title: 'A Lucid run was cut off',
        text: 'A restart or update stopped it. It is tried again about an hour after it started; the wiki window can start one now.',
      });
      return;
    case 'dream.lucid.done':
      inbox.resolve('lucid');
      return;

    // ── Sentinel checks ──
    case 'sentinel.check.paused': {
      const id = str(line.triggerId);
      if (!id) return;
      const name = str(line.name) || id;
      const agent = str(line.agent);
      const cap = str(line.kind) === 'cap';
      inbox.raise(`sentinel:${id}`, {
        kind: 'sentinel',
        level: cap ? 'info' : 'warning',
        title: cap ? `Sentinel check "${name}" waits until tomorrow` : `Sentinel check "${name}" stopped`,
        text: cap
          ? `It woke ${agent || 'its agent'} as often as one day allows and starts again after midnight UTC. ${str(line.reason)}`
          : `${str(line.reason)}\n\nIt no longer checks or wakes ${agent || 'its agent'}. Resume it in the Sentinel window once the cause is fixed, or ask the agent to update the script.`,
      });
      return;
    }
    case 'sentinel.check.resumed':
    case 'sentinel.trigger.deleted': {
      const id = str(line.triggerId);
      if (id) inbox.resolve(`sentinel:${id}`);
      return;
    }

    // ── Logins ──
    case 'turn.engine_init': {
      const turnId = str(line.turnId);
      if (turnId) rememberTurn(turnId, str(line.provider));
      return;
    }
    case 'engine.fail':
    case 'turn.engine_error': {
      const engine = str(line.engine);
      const err = str(line.err) || str(line.error) || str(line.message);
      if (!engine || !LOGIN_ERROR.test(err)) return;
      const provider = str(line.provider) || turnProvider.get(str(line.turnId)) || '';
      // engine.fail does not name the provider; turn.engine_error does,
      // through its turn. An OpenAI compatible refusal waits for that.
      if (engine === 'openai-compatible' && !provider) return;
      inbox.raise(loginKey(engine, provider), {
        kind: 'login',
        level: 'important',
        title: loginTitle(engine, provider),
        text: `${loginHint(engine, provider)}\n\n${err.slice(0, 300)}`,
      });
      return;
    }
    case 'engine.turn': {
      const engine = str(line.engine);
      if (engine) inbox.resolve(loginKey(engine, str(line.provider)));
      return;
    }

    // ── Tool servers and models come back ──
    case 'mcp.hub.connected': {
      const server = str(line.server);
      if (server) {
        inbox.resolve(`mcp:${server}`);
        inbox.resolve(`login:mcp:${server}`);
      }
      return;
    }
    case 'model.available_again': {
      const model = str(line.model);
      if (model) inbox.resolve(`model:${model}`);
      return;
    }
  }
}

export interface InboxStateSources {
  version: string;
  update: () => { updateAvailable: boolean; latestVersion: string | null; note: string | null; enabled: boolean };
  configProblem: () => { since: number | string; message: string } | null;
  mcpServers: () => Record<string, { state: string; lastError?: string; loginHint?: string; lastConnectedAt?: number }>;
  unavailableModels: () => Array<{ ref: string; reason: string }>;
  /** Entries of subagents.tools.deny that name no tool (a typo). */
  subagentDenyUnknown?: () => string[];
}

/** States without a single event, checked every few minutes. */
export function inboxFromState(inbox: Inbox, src: InboxStateSources, now = Date.now()): void {
  // A newer version.
  const u = src.update();
  if (u.updateAvailable && u.latestVersion) {
    inbox.resolvePrefix('update:', `update:${u.latestVersion}`);
    inbox.raise(`update:${u.latestVersion}`, {
      kind: 'update',
      level: 'info',
      title: `somora ${u.latestVersion} is available`,
      text: `You run ${src.version}. Update on the server with \`somora update\`. The release notes say what changes.`,
      url: `https://github.com/thenaxon/somora_agent/releases/tag/v${u.latestVersion}`,
    }, { count: false });
  } else {
    inbox.resolvePrefix('update:');
  }

  // somora.ai's note — one entry per text: the same text never twice.
  const note = u.enabled ? (u.note ?? '').trim() : '';
  if (note) {
    const key = `news:${createHash('sha256').update(note).digest('hex').slice(0, 16)}`;
    inbox.resolvePrefix('news:', key);
    inbox.raise(key, { kind: 'news', level: 'info', title: 'Message from somora.ai', text: note }, { count: false });
  } else {
    inbox.resolvePrefix('news:');
  }

  // config.yaml does not validate.
  const problem = src.configProblem();
  if (problem) {
    inbox.raise('config', {
      kind: 'config',
      level: 'important',
      title: 'config.yaml has a mistake',
      text: `somora keeps running on the last valid version until it is fixed. \`somora config check\` shows the same.\n\n${problem.message.slice(0, 900)}`,
    }, { count: false });
  } else {
    inbox.resolve('config');
  }

  // subagents.tools.deny names a tool that does not exist — most likely
  // a typo, and then the tool it meant is still there.
  const unknown = src.subagentDenyUnknown?.() ?? [];
  if (unknown.length > 0) {
    inbox.raise('config:subagents-deny', {
      kind: 'config',
      level: 'warning',
      title: 'subagents.tools.deny names a tool somora does not have',
      text: `${unknown.map((u) => `\`${u}\``).join(', ')} in config.yaml matches nothing, so it hides nothing. A typo? The rest of the list applies.`,
    }, { count: false });
  } else {
    inbox.resolve('config:subagents-deny');
  }

  // Tool servers: a lost login at once, an outage after a day.
  for (const [name, s] of Object.entries(src.mcpServers())) {
    if (s.state === 'connected') {
      inbox.resolve(`mcp:${name}`);
      inbox.resolve(`login:mcp:${name}`);
      continue;
    }
    if (s.state === 'needs-auth') {
      inbox.raise(`login:mcp:${name}`, {
        kind: 'login',
        level: 'important',
        title: `Tool server ${name} wants a new login`,
        text: `Its tools are missing until then. ${s.loginHint ?? 'See docs/mcp.md for how this server logs in.'}${s.lastError ? `\n\n${s.lastError.slice(0, 300)}` : ''}`,
      }, { count: false });
      continue;
    }
    if (s.state !== 'failed') continue;
    const o = inbox.observe(`mcp:${name}`);
    const since = Math.min(o.firstSeen, s.lastConnectedAt ?? o.firstSeen);
    if (now - o.firstSeen >= GONE_FOR_MS) {
      inbox.raise(`mcp:${name}`, {
        kind: 'mcp',
        level: 'info',
        title: `Tool server ${name} is unreachable`,
        text: `Since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')}. Agents do not get its tools meanwhile. Switched off on purpose? "Don't report again" keeps this quiet.${s.lastError ? `\n\n${s.lastError.slice(0, 300)}` : ''}`,
      }, { count: false });
    }
  }

  // Models: an outage that lasts a day. Chat, REM and the dream phases
  // fall back meanwhile; this says that they do.
  for (const m of src.unavailableModels()) {
    const o = inbox.observe(`model:${m.ref}`);
    if (now - o.firstSeen >= GONE_FOR_MS) {
      inbox.raise(`model:${m.ref}`, {
        kind: 'model',
        level: 'info',
        title: `Model ${m.ref} is unreachable`,
        text: `Since ${new Date(o.firstSeen).toISOString().slice(0, 16).replace('T', ' ')}. Where it is the first choice, the backup models answer. Switched off on purpose? "Don't report again" keeps this quiet.\n\n${m.reason.slice(0, 300)}`,
      }, { count: false });
    }
  }
}
