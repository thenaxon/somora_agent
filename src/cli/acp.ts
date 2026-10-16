// `somora acp [--agent <name>] [--session <name>]` (docs/acp.md): a
// somora agent as an ACP agent over stdio, for editors (Zed, JetBrains)
// and other agent systems. A thin client of the running server; stdout
// carries the protocol, so every diagnostic goes to stderr.

import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { SomoraAcpAgent, type HttpFetch } from '../acp/somora-agent.ts';
import { loopbackFetch } from '../server/loopback-fetch.ts';
import { resolveServerBase } from './server-base.ts';
import { SOMORA_VERSION } from '../version.ts';

function usage(): string {
  return [
    'usage: somora acp [--agent <name>] [--session <name>]',
    '',
    'Speaks ACP (Agent Client Protocol) on stdin/stdout for an editor or another',
    'agent system, and talks to the running somora server like the TUI does.',
    '',
    '  --agent <name>     the somora agent to talk to (default: the first one)',
    '  --session <name>   every new conversation opens this session (e.g. main)',
    '                     instead of a new one',
    '',
  ].join('\n');
}

export async function runAcpCli(args: string[]): Promise<number> {
  let agent: string | undefined;
  let session: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent') agent = args[++i];
    else if (a === '--session') session = args[++i];
    else if (a === '--help' || a === '-h') {
      process.stderr.write(usage());
      return 0;
    } else {
      process.stderr.write(`unknown argument: ${a}\n${usage()}`);
      return 2;
    }
  }
  const log = (line: string) => process.stderr.write(`somora acp: ${line}\n`);
  const base = await resolveServerBase();
  const fetch = loopbackFetch as unknown as HttpFetch;
  if (!agent) {
    try {
      const res = await fetch(`${base}/agents`);
      const list = (await res.json()) as Array<{ name: string; kind?: string }>;
      agent = list.filter((x) => x.kind !== 'external').map((x) => x.name).sort()[0];
    } catch (err) {
      log(`somora server not reachable at ${base}: ${(err as Error).message}`);
      return 1;
    }
    if (!agent) {
      log('this somora has no agents');
      return 1;
    }
  }
  log(`agent ${agent} at ${base}`);
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const conn = new AgentSideConnection(
    (c) => new SomoraAcpAgent(c, { base, agent: agent!, ...(session ? { session } : {}), version: SOMORA_VERSION, fetch, log }),
    stream,
  );
  await conn.closed;
  return 0;
}
