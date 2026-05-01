import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

const port = Number(process.env.SOMORA_PORT ?? 18737);
const host = process.env.SOMORA_HOST ?? '127.0.0.1';
const base = `http://${host}:${port}`;

let agent = 'hans';
let session = 'main';
let waiting = false;
let streamAbort: AbortController | null = null;

interface TurnStats {
  tokensIn: number;
  tokensInCached: number | null;
  tokensOut: number;
  contextWindow: number | null;
  provider: string | null;
  model: string | null;
}
let lastTurn: TurnStats | null = null;

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Honest token-display:
//   `[hans:main · 78k+540k¢ / 400k · ↓800]>`
//                ^new ^cached ^window  ^out
// "+Xk¢" appears only when cached tokens are surfaced (codex-cli,
// openai-compatible, claude-cli with cache-read>0).
//
// Without cache info we fall back to the simpler single-number view
// to keep the prompt readable.
const promptStr = () => {
  const parts = [`${agent}:${session}`];
  if (lastTurn) {
    const cached = lastTurn.tokensInCached;
    const total = lastTurn.tokensIn;
    if (cached !== null && cached > 0 && total >= cached) {
      const uncached = total - cached;
      const inSegment = `${formatTokens(uncached)}+${formatTokens(cached)}¢`;
      if (lastTurn.contextWindow) {
        parts.push(`${inSegment} / ${formatTokens(lastTurn.contextWindow)}`);
      } else {
        parts.push(`↑${inSegment}`);
      }
    } else {
      if (lastTurn.contextWindow) {
        parts.push(`${formatTokens(total)}/${formatTokens(lastTurn.contextWindow)}`);
      } else {
        parts.push(`${formatTokens(total)}↑`);
      }
    }
    parts.push(`↓${formatTokens(lastTurn.tokensOut)}`);
  }
  return `[${parts.join(' · ')}]> `;
};
const rl = readline.createInterface({ input: stdin, output: stdout });

// Append-only message rendering. Cumulative deltas: each delta is the full
// text so far, so we only print the suffix beyond what's already on screen.
let displayedText = '';
let firstChunkOfMessage = true;
let messageFinalized = false;

function startNewMessage(): void {
  if (!firstChunkOfMessage && !messageFinalized) {
    stdout.write('\n');
  }
  displayedText = '';
  firstChunkOfMessage = true;
  messageFinalized = false;
}

function renderDelta(text: string): void {
  if (firstChunkOfMessage) {
    stdout.write(`${agent}: `);
    firstChunkOfMessage = false;
  }
  if (text.startsWith(displayedText)) {
    stdout.write(text.slice(displayedText.length));
  } else {
    stdout.write(`\n${agent}: ${text}`);
  }
  displayedText = text;
}

function finalizeMessage(text: string): void {
  renderDelta(text);
  stdout.write('\n');
  messageFinalized = true;
}

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
const isAnsiTty = Boolean(stdout.isTTY);

function dim(text: string): string {
  return isAnsiTty ? `${ANSI_DIM}${text}${ANSI_RESET}` : text;
}

function summarize(value: unknown, maxLen = 160): string {
  if (value === undefined || value === null) return '';
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '';
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd() + '…';
  return s;
}

function formatToolEvent(data: any): string {
  // Strip the mcp__<server>__ prefix so the line stays readable.
  const tool = (data.tool ?? '').replace(/^mcp__[^_]+__/, '');
  if (data.phase === 'call') {
    const argSummary = summarize(data.input, 140);
    return `\n[tool call · ${tool}${argSummary ? ' · ' + argSummary : ''}]\n`;
  }
  if (data.phase === 'result') {
    if (data.error) {
      return `\n[tool error · ${summarize(data.error, 200)}]\n`;
    }
    const out = summarize(data.output, 140);
    return `\n[tool result${out ? ' · ' + out : ''}]\n`;
  }
  return `\n[tool ${data.phase ?? '?'}: ${tool}]\n`;
}

// Auto-reconnect with backoff. Resets on every successful `connected` event,
// so a long healthy run isn't penalized by an early hiccup.
let reconnectDelayMs = 500;
const RECONNECT_DELAY_MAX = 10_000;

async function consumeStream(): Promise<void> {
  if (streamAbort) streamAbort.abort();
  const ctrl = new AbortController();
  streamAbort = ctrl;

  const url = `${base}/chat/stream?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    stdout.write(`\n[!] stream-connect failed: ${(err as Error).message} — retrying in ${reconnectDelayMs}ms\n`);
    scheduleReconnect(ctrl);
    return;
  }
  if (!res.ok) {
    const body = await res.text();
    stdout.write(`\n[!] stream-connect ${res.status}: ${body}\n`);
    rl.prompt();
    return;
  }
  if (!res.body) {
    stdout.write('\n[!] stream connect: no body\n');
    rl.prompt();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let evName = 'message';
        let dataStr = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) evName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        let data: any;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (evName === 'chat') {
          if (data.state === 'delta') renderDelta(data.text);
          else if (data.state === 'final') finalizeMessage(data.text);
        } else if (evName === 'agent') {
          if (data.phase === 'start') startNewMessage();
          else if (data.phase === 'end') {
            if (data.usage) {
              lastTurn = {
                tokensIn: data.usage.tokens_in ?? 0,
                tokensInCached: data.usage.tokens_in_cached ?? null,
                tokensOut: data.usage.tokens_out ?? 0,
                contextWindow: data.contextWindow ?? null,
                provider: data.provider ?? null,
                model: data.model ?? null,
              };
              rl.setPrompt(promptStr());
            }
            waiting = false;
            rl.prompt();
          }
        } else if (evName === 'memory') {
          // Auto-inject summary — what the runtime pulled from memory before
          // the engine ran. Dimmed so it doesn't compete with Hans's prose.
          const refs = (data.refs as string[] | undefined) ?? [];
          const topScore =
            typeof data.topScore === 'number' ? ` · top=${data.topScore.toFixed(2)}` : '';
          const refList = refs.length ? ` · ${refs.join(', ')}` : '';
          stdout.write(dim(`\n[memory · ${data.count ?? 0} hits${topScore}${refList}]\n`));
        } else if (evName === 'tool') {
          stdout.write(dim(formatToolEvent(data)));
        } else if (evName === 'status' && data.msg === 'connected') {
          // Healthy connect — reset backoff
          reconnectDelayMs = 500;
          rl.prompt();
        } else if (evName === 'heartbeat') {
          // Server keep-alive, nothing to render
          continue;
        }
      }
    }
    // EOF without abort means server closed the stream — try to reconnect
    if (!ctrl.signal.aborted) {
      stdout.write(`\n[!] stream closed by server — reconnecting in ${reconnectDelayMs}ms\n`);
      scheduleReconnect(ctrl);
    }
  } catch (err) {
    if (ctrl.signal.aborted) return;
    stdout.write(`\n[!] stream error: ${(err as Error).message} — reconnecting in ${reconnectDelayMs}ms\n`);
    scheduleReconnect(ctrl);
  }
}

function scheduleReconnect(ctrl: AbortController): void {
  // Only fire if this controller is still the active one — prevents a stale
  // connection's reconnect from racing with an explicit agent/session switch
  // that already started a fresh consumeStream().
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX);
  setTimeout(() => {
    if (streamAbort !== ctrl) return;
    void consumeStream();
  }, delay);
}

function reconnectStream(): void {
  reconnectDelayMs = 500;
  void consumeStream();
}

async function send(text: string): Promise<void> {
  const res = await fetch(`${base}/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, session, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
}

interface AgentInfo {
  name: string;
  description: string;
  icon?: string;
}

interface SessionSummary {
  id: string;
  slug: string;
  isMain: boolean;
  createdAt: string | null;
  lastActivity: string | null;
  messageCount: number;
}

async function fetchAgents(): Promise<AgentInfo[]> {
  const res = await fetch(`${base}/agents`);
  return (await res.json()) as AgentInfo[];
}

async function fetchSessions(forAgent: string): Promise<SessionSummary[]> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(forAgent)}/sessions`);
  if (!res.ok) return [];
  return (await res.json()) as SessionSummary[];
}

async function createNewSession(forAgent: string, slug: string): Promise<string> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(forAgent)}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function resetCurrentSession(): Promise<{ archivedId: string | null; reason?: string }> {
  const res = await fetch(
    `${base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/reset`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { archivedId: string | null; reason?: string };
}

interface ModelInfo {
  provider: string;
  id: string;
  alias: string | null;
  engine: string;
  contextWindow: number;
  capabilities: string[];
  ref: string;
}

async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${base}/models`);
  if (!res.ok) return [];
  return (await res.json()) as ModelInfo[];
}

interface SessionModelInfo {
  provider: string;
  modelId: string;
  alias: string | null;
  engine: string;
  contextWindow: number;
  source: 'session-override' | 'persona-default';
  override: string | null;
  personaDefault: string | null;
}

async function fetchSessionModel(forAgent: string, forSession: string): Promise<SessionModelInfo | null> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(forAgent)}/sessions/${encodeURIComponent(forSession)}/model`);
  if (!res.ok) return null;
  return (await res.json()) as SessionModelInfo;
}

async function setSessionModel(forAgent: string, forSession: string, ref: string): Promise<void> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(forAgent)}/sessions/${encodeURIComponent(forSession)}/model`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ref }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function clearSessionModel(forAgent: string, forSession: string): Promise<void> {
  const res = await fetch(`${base}/agents/${encodeURIComponent(forAgent)}/sessions/${encodeURIComponent(forSession)}/model`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await res.text());
}

async function switchTo(newAgent: string, newSession: string): Promise<void> {
  agent = newAgent;
  session = newSession;
  lastTurn = null; // stats are session-scoped; clear on switch
  rl.setPrompt(promptStr());
  reconnectStream();
}

const HELP = `
Available commands:
  /help                       — show this help
  /agents                     — list agents
  /agent <name> [session]     — switch agent (defaults to main session)
  /sessions                   — list sessions of current agent
  /session <slug-or-id>       — switch to another session of current agent
  /new <slug>                 — create new session and switch to it
  /main                       — back to main session of current agent
  /reset                      — preview reset of current session
  /reset YES                  — archive current session, start fresh
  /models                     — list all configured models with aliases
  /model                      — show current effective model for this session
  /model <alias-or-ref>       — override model for this session
  /model default              — clear override, fall back to persona model
  /quit, /exit                — leave somora
`;

async function handleCommand(line: string): Promise<void> {
  const [cmd, ...args] = line.split(/\s+/);
  switch (cmd) {
    case '/help':
      stdout.write(HELP);
      rl.prompt();
      return;
    case '/quit':
    case '/exit':
      rl.close();
      process.exit(0);
    case '/agents': {
      const agents = await fetchAgents();
      stdout.write('\nAgents:\n');
      for (const a of agents) {
        const marker = a.name === agent ? '*' : ' ';
        const icon = a.icon ? `${a.icon} ` : '';
        const desc = a.description ? ` — ${a.description}` : '';
        stdout.write(`  ${marker} ${icon}${a.name}${desc}\n`);
      }
      rl.prompt();
      return;
    }
    case '/agent': {
      const name = args[0];
      if (!name) {
        stdout.write('usage: /agent <name> [session]\n');
        rl.prompt();
        return;
      }
      await switchTo(name, args[1] ?? 'main');
      return;
    }
    case '/sessions': {
      const sessions = await fetchSessions(agent);
      stdout.write(`\nSessions for ${agent}:\n`);
      for (const s of sessions) {
        const marker = s.id === session || s.slug === session ? '*' : ' ';
        const stamp = s.lastActivity ? s.lastActivity.slice(0, 16).replace('T', ' ') : 'empty';
        stdout.write(`  ${marker} ${s.slug.padEnd(24)}  ${String(s.messageCount).padStart(3)} msgs  ${stamp}\n`);
      }
      rl.prompt();
      return;
    }
    case '/session': {
      const ref = args[0];
      if (!ref) {
        stdout.write('usage: /session <slug-or-id>\n');
        rl.prompt();
        return;
      }
      await switchTo(agent, ref);
      return;
    }
    case '/new': {
      const slug = args[0];
      if (!slug) {
        stdout.write('usage: /new <slug>\n');
        rl.prompt();
        return;
      }
      try {
        const id = await createNewSession(agent, slug);
        await switchTo(agent, id);
      } catch (err) {
        stdout.write(`\n[!] ${(err as Error).message}\n`);
        rl.prompt();
      }
      return;
    }
    case '/main':
      await switchTo(agent, 'main');
      return;
    case '/reset': {
      // Two-step confirmation. `/reset` prints what will happen + the
      // archive path; user has to follow up with `/reset YES` to commit.
      // This is destructive enough that a single keystroke shouldn't do it.
      if (args[0] !== 'YES') {
        const altHint =
          session !== 'main'
            ? `\n        Alternative for non-main sessions: /new <new-slug>` +
              `\n        leaves this session intact and starts a fresh one.`
            : '';
        stdout.write(
          `\n[/reset] would archive the CURRENT session (${agent}:${session}) and start fresh.` +
            `\n        Existing JSONL + meta are preserved as a timestamped archive` +
            `\n        you can resume any time with /session <id>.` +
            altHint +
            `\n        To commit: /reset YES\n`,
        );
        rl.prompt();
        return;
      }
      try {
        const result = await resetCurrentSession();
        if (result.archivedId) {
          stdout.write(
            `\n[reset done] archived as: ${result.archivedId}` +
              `\n             current session is now empty + clean.\n`,
          );
        } else {
          stdout.write(`\n[reset noop] ${result.reason ?? 'nothing to archive'}\n`);
        }
        // Refresh session-scoped stats since we just wiped them.
        lastTurn = null;
        rl.setPrompt(promptStr());
      } catch (err) {
        stdout.write(`\n[!] ${(err as Error).message}\n`);
      }
      rl.prompt();
      return;
    }
    case '/models': {
      const models = await fetchModels();
      stdout.write('\nModels:\n');
      const aliasW = Math.max(5, ...models.map((m) => (m.alias ?? '-').length));
      const refW = Math.max(20, ...models.map((m) => `${m.provider}/${m.id}`.length));
      stdout.write(`  ${'alias'.padEnd(aliasW)}  ${'provider/id'.padEnd(refW)}  engine                 ctx     caps\n`);
      for (const m of models) {
        const alias = (m.alias ?? '-').padEnd(aliasW);
        const ref = `${m.provider}/${m.id}`.padEnd(refW);
        const engine = m.engine.padEnd(22);
        const ctx = `${(m.contextWindow / 1000).toFixed(0)}k`.padStart(6);
        const caps = m.capabilities.join(',');
        stdout.write(`  ${alias}  ${ref}  ${engine}  ${ctx}  ${caps}\n`);
      }
      rl.prompt();
      return;
    }
    case '/model': {
      const ref = args[0];
      if (!ref) {
        const info = await fetchSessionModel(agent, session);
        if (!info) {
          stdout.write('\n[!] could not fetch session model\n');
        } else {
          const aliasPart = info.alias ? ` (alias: ${info.alias})` : '';
          const sourcePart = info.source === 'session-override'
            ? ` — session-override (persona default: ${info.personaDefault ?? '(none)'})`
            : ' — persona default';
          stdout.write(`\nEffective: ${info.provider}/${info.modelId}${aliasPart}\n  engine: ${info.engine}, context: ${info.contextWindow}${sourcePart}\n`);
        }
        rl.prompt();
        return;
      }
      if (ref === 'default' || ref === '-') {
        try {
          await clearSessionModel(agent, session);
          stdout.write('\nmodel override cleared, back to persona default\n');
        } catch (err) {
          stdout.write(`\n[!] ${(err as Error).message}\n`);
        }
        rl.prompt();
        return;
      }
      try {
        await setSessionModel(agent, session, ref);
        stdout.write(`\nmodel set to: ${ref} (for session ${session})\n`);
      } catch (err) {
        stdout.write(`\n[!] ${(err as Error).message}\n`);
      }
      rl.prompt();
      return;
    }
    default:
      stdout.write(`unknown command: ${cmd}. Try /help\n`);
      rl.prompt();
  }
}

async function main(): Promise<void> {
  rl.setPrompt(promptStr());
  reconnectStream();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!waiting) rl.prompt();
      return;
    }
    if (trimmed.startsWith('/')) {
      try {
        await handleCommand(trimmed);
      } catch (err) {
        stdout.write(`\ncommand failed: ${(err as Error).message}\n`);
        rl.prompt();
      }
      return;
    }
    waiting = true;
    try {
      await send(trimmed);
    } catch (err) {
      stdout.write(`\nsend failed: ${(err as Error).message}\n`);
      waiting = false;
      rl.prompt();
    }
  });

  rl.on('close', () => process.exit(0));
}

main();
