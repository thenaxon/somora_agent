import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

const port = Number(process.env.SOMORA_PORT ?? 18737);
const host = process.env.SOMORA_HOST ?? '127.0.0.1';
const base = `http://${host}:${port}`;

let agent = 'hans';
let session = 'main';
let waiting = false;

const promptStr = () => `[${agent}:${session}]> `;
const rl = readline.createInterface({ input: stdin, output: stdout });

// Append-only message rendering. Cumulative deltas: each new delta is the full
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
    // text diverged from what's on screen — break to a new line and reprint
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
  const url = `${base}/chat/stream?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`;
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`stream connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

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
}

async function send(text: string): Promise<void> {
  await fetch(`${base}/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, session, text }),
  });
}

async function main(): Promise<void> {
  rl.setPrompt(promptStr());
  consumeStream().catch((err) => {
    console.error(`\nstream error: ${err.message}`);
    process.exit(1);
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!waiting) rl.prompt();
      return;
    }
    if (trimmed === '/quit' || trimmed === '/exit') {
      rl.close();
      process.exit(0);
    }
    waiting = true;
    try {
      await send(trimmed);
    } catch (err) {
      console.error(`send failed: ${(err as Error).message}`);
      waiting = false;
      rl.prompt();
    }
  });

  rl.on('close', () => process.exit(0));
}

main();
