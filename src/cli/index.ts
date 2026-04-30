import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

const port = Number(process.env.SOMORA_PORT ?? 18737);
const host = process.env.SOMORA_HOST ?? '127.0.0.1';
const base = `http://${host}:${port}`;

let agent = 'hans';
let session = 'main';
let waiting = false;
let streamAbort: AbortController | null = null;

const promptStr = () => `[${agent}:${session}]> `;
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
    throw err;
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
            waiting = false;
            rl.prompt();
          }
        } else if (evName === 'tool') {
          stdout.write(`\n[tool ${data.phase}: ${data.tool ?? ''}]\n`);
        } else if (evName === 'status' && data.msg === 'connected') {
          rl.prompt();
        }
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted) return;
    stdout.write(`\nstream error: ${(err as Error).message}\n`);
  }
}

function reconnectStream(): void {
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

async function switchTo(newAgent: string, newSession: string): Promise<void> {
  agent = newAgent;
  session = newSession;
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
        const desc = a.description ? ` — ${a.description}` : '';
        stdout.write(`  ${marker} ${a.name}${desc}\n`);
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
