#!/usr/bin/env -S npx tsx
// Standalone MCP server. Spawned as a child process by claude-cli /
// codex-cli for the duration of a turn. Exposes the in-process tool
// registry over stdio so the LLM can call memory_*, etc.
//
// Lifecycle: launched fresh per query by the parent CLI, lives only as
// long as that query. We do NOT share state with the somora HTTP server
// — each MCP child loads its own config, builds its own ToolRegistry,
// and constructs its own MemoryManager via getMemoryManager() (which
// is process-local, so each child has its own embedder etc.).
//
// Scope: the agent name comes from SOMORA_AGENT env var, set by the
// engine adapter when spawning. Without it the server refuses to start —
// otherwise tool calls would have no clear target agent.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { loadConfig } from '../config/loader.ts';
import { getMemoryManager, shutdownMemoryRegistry } from '../memory/registry.ts';
import { logger } from '../server/logger.ts';
import {
  dreamTools,
  memoryTools,
  obsidianTools,
  resourceTools,
  somoraDocsTools,
  timeTools,
  ToolRegistry,
  webTools,
} from '../tools/index.ts';
import type { ToolContext } from '../tools/types.ts';

async function main(): Promise<void> {
  const agent = process.env.SOMORA_AGENT;
  if (!agent || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(agent)) {
    process.stderr.write(
      'somora-mcp: SOMORA_AGENT env var required (the agent name to scope tools to).\n',
    );
    process.exit(2);
  }

  const config = await loadConfig();
  const registry = new ToolRegistry();
  registry.registerMany(memoryTools());
  registry.registerMany(dreamTools());
  registry.registerMany(timeTools());
  registry.registerMany(webTools());
  registry.registerMany(obsidianTools());
  registry.registerMany(somoraDocsTools());
  registry.registerMany(resourceTools());

  const ctx: ToolContext = {
    agent,
    getMemoryManager: () => getMemoryManager(agent, { config: config.memory }),
    config,
  };

  const server = new McpServer(
    { name: 'somora-memory', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  for (const tool of registry.list()) {
    // Each tool's inputSchema is a `z.object({...})`; the high-level MCP
    // server wants the raw shape (z's internal `.shape` accessor), not the
    // wrapping ZodObject. Extract it without losing types we care about.
    const inputShape = (tool.inputSchema as unknown as ZodObject<ZodRawShape>).shape;

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputShape,
      },
      async (args: unknown) => {
        const result = await registry.invoke(tool.name, args, ctx);
        if (!result.ok) {
          return {
            content: [{ type: 'text', text: result.error ?? 'tool failed' }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
        };
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({
    msg: 'mcp.server_started',
    agent,
    tools: registry.list().map((t) => t.name),
  });

  // Pino + the stdio transport both use process.stdout. We need to make
  // sure pino is in worker-thread/file mode so it doesn't pollute the
  // JSON-RPC stream. Our default logger config already targets a file +
  // pino-pretty on the TTY — pino-pretty writes to stdout but only when
  // isTTY=true, which it isn't here (we're spawned). So in practice the
  // log goes to ~/.somora/logs/server-YYYY-MM-DD.log and not stdout. If
  // a future change breaks that invariant, the MCP handshake will fail
  // because the client can't parse the resulting mixed stream.

  // Graceful shutdown — let the parent close stdin and we exit cleanly.
  const shutdown = async (signal: string) => {
    logger.info({ msg: 'mcp.server_shutdown', signal });
    await server.close().catch(() => {});
    await shutdownMemoryRegistry();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // stdio transport closes when peer ends — node would exit naturally,
  // but make sure we clean up the embedder/db handles first.
  process.stdin.on('end', () => void shutdown('stdin-end'));
}

main().catch((err) => {
  process.stderr.write(`somora-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
