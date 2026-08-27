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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { loadConfig } from '../config/loader.ts';
import { resolveAnyRef } from '../config/types.ts';
import { setMaxWikiCallsPerTurn } from '../dream/loop-state.ts';
import { getMemoryManager, shutdownMemoryRegistry } from '../memory/registry.ts';
import { loadPersona } from '../persona/loader.ts';
import { logger } from '../server/logger.ts';
import { isToolAllowed } from '../tools/gating.ts';
import { configureLongTaskTimeouts } from '../tools/agents/long-task-timeouts.ts';
import { configureExecConcurrencyCaps } from '../tools/exec/index.ts';
import { registerAllTools, ToolRegistry } from '../tools/index.ts';
import type { ToolContext } from '../tools/types.ts';

/**
 * External-MCP proxy mode (design: private/mcp-hub-design.md §4.4).
 * Serves ONE upstream server's tools to the parent CLI: tools/list from
 * the catalog snapshot the main server maintains, tools/call forwarded
 * via POST /mcp/call to the hub — the child never talks to the upstream
 * itself, so there is exactly one real MCP client per deployment.
 */
async function proxyMain(agent: string, proxyServer: string): Promise<void> {
  const { readCatalog } = await import('./hub/catalog.ts');
  const { loopbackFetch, classifyFetchError } = await import('../server/loopback-fetch.ts');

  const persona = await loadPersona(agent);
  const toolGating = persona?.toolGating;

  const catalog = await readCatalog();
  const entry = catalog?.servers[proxyServer];
  const prefix = `mcp__${proxyServer}__`;
  // Not-connected or missing → expose zero tools, don't fail the turn.
  const tools = (entry?.state === 'connected' ? entry.tools : []).filter((t) =>
    isToolAllowed(t.fullName, 'mcp', toolGating),
  );
  if (tools.length === 0) {
    logger.info({
      msg: 'mcp.proxy_no_tools',
      agent,
      server: proxyServer,
      state: entry?.state ?? 'absent-from-catalog',
    });
  }

  const server = new Server(
    { name: `somora-${proxyServer}`, version: '1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      // The CLI namespaces with OUR server entry name, so expose the
      // bare tool segment: mcp__somora-<server>__<tool>.
      name: t.fullName.startsWith(prefix) ? t.fullName.slice(prefix.length) : t.fullName,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const shortName = req.params.name;
    const tool = tools.find(
      (t) => t.fullName === `${prefix}${shortName}` || t.fullName === shortName,
    );
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `unknown tool '${shortName}' on ${proxyServer}` }],
        isError: true,
      };
    }
    const host = process.env.SOMORA_HOST || '127.0.0.1';
    const port = process.env.SOMORA_PORT || '18737';
    const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
    try {
      const res = await loopbackFetch(`${scheme}://${host}:${port}/mcp/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: proxyServer,
          tool: tool.rawName,
          args: req.params.arguments ?? {},
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          content: [
            { type: 'text' as const, text: `MCP hub call failed: HTTP ${res.status} ${body}` },
          ],
          isError: true,
        };
      }
      const result = (await res.json()) as {
        isError: boolean;
        text: string;
        images: Array<{ data: string; mimeType: string }>;
      };
      return {
        content: [
          ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
          ...result.images.map((img) => ({
            type: 'image' as const,
            data: img.data,
            mimeType: img.mimeType,
          })),
        ],
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (err) {
      const classified = classifyFetchError(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: `MCP hub unreachable (${classified.category}): ${classified.hint}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({
    msg: 'mcp.proxy_started',
    agent,
    server: proxyServer,
    tools: tools.length,
  });

  const shutdown = async (signal: string) => {
    logger.info({ msg: 'mcp.proxy_shutdown', agent, server: proxyServer, signal });
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.stdin.on('end', () => void shutdown('stdin-end'));
}

async function main(): Promise<void> {
  const agent = process.env.SOMORA_AGENT;
  if (!agent || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(agent)) {
    process.stderr.write(
      'somora-mcp: SOMORA_AGENT env var required (the agent name to scope tools to).\n',
    );
    process.exit(2);
  }

  // Proxy mode: serve one external server's catalog, skip the whole
  // registry/memory bootstrap (no embedder warmup for a pure forward).
  const proxyServer = process.env.SOMORA_MCP_PROXY_SERVER;
  if (proxyServer) {
    await proxyMain(agent, proxyServer);
    return;
  }

  const config = await loadConfig();
  // Match the main server: tools that read longTaskDefault/Max via the
  // module-level cache (subagent_result, spawn_subagent wait:true) need
  // this populated here too — each MCP child has its own process state.
  configureLongTaskTimeouts(config);
  configureExecConcurrencyCaps(
    config.agentLoop.execMaxConcurrentPerAgent,
    config.agentLoop.execMaxConcurrentGlobal,
  );
  // Wiki-lucid per-turn cap: loop-state's counter lives per-process, and
  // wiki_edit for the CLI engines is enforced HERE, not in the main
  // server. Without this the child stays on the module default while the
  // main server's <wiki-review-mode> prompt promises the config value —
  // the 3-vs-10 contradiction from the 2026-07-20 lucid-loop report.
  setMaxWikiCallsPerTurn(config.wiki.lucid.maxCallsPerTurn);
  const registry = new ToolRegistry();
  // Single source of truth in src/tools/index.ts so this can't drift
  // from the in-process registry in src/server/index.ts. Adding a new
  // tool: edit registerAllTools(), both surfaces pick it up.
  registerAllTools(registry);

  // Optional sub-context env hooks set by the engine launcher per turn.
  // SOMORA_SESSION lets spawn_subagent record `parent_session`; the
  // depth feeds the recursion cap. SOMORA_ACTIVE_MODEL surfaces the
  // turn's resolved model so capability-gated tools (file_read
  // polymorph) can check `image`/`pdf` capability before deciding
  // whether to return multimodal content blocks.
  const session = process.env.SOMORA_SESSION || undefined;
  const subagentDepth = parseInt(process.env.SOMORA_SUBAGENT_DEPTH ?? '', 10);
  const activeModelRef = process.env.SOMORA_ACTIVE_MODEL || undefined;
  const activeModel = activeModelRef ? resolveAnyRef(config, activeModelRef) ?? undefined : undefined;
  if (activeModelRef && !activeModel) {
    logger.warn({
      msg: 'mcp.active_model_unresolved',
      ref: activeModelRef,
      hint: 'capability-gated tools will treat the model as text-only',
    });
  }

  const ctx: ToolContext = {
    agent,
    ...(session ? { session } : {}),
    ...(Number.isFinite(subagentDepth) && subagentDepth > 0 ? { subagentDepth } : {}),
    ...(activeModel ? { activeModel } : {}),
    getMemoryManager: () =>
      getMemoryManager(agent, {
        config: config.memory,
        obsidian: config.obsidian,
        wiki: config.wiki,
      }),
    config,
  };

  const server = new McpServer(
    { name: 'somora-memory', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  // Per-agent gating (agent.yaml tools:) — same matcher as the
  // in-process ToolInvoker filter in run-turn.ts, so claude-cli/
  // codex-cli see exactly the gated set the openai-compat path sees.
  const persona = await loadPersona(agent);
  const toolGating = persona?.toolGating;

  // ...and the same availability probe, for the same reason. run-turn
  // builds the model's list from listAvailable(ctx); this used to walk
  // registry.list(), so the three MCP-served engines (claude-cli,
  // codex-cli, grok-cli) were offered every config-gated tool whether
  // or not its config existed — measured 2026-08-27 as 8 dead tools
  // (~2k tokens of schema) on an instance with no wiki/memory config,
  // each of which invoke() then refuses with "not available in this
  // context". Offering a tool that cannot run is worse than not
  // offering it: the model spends a call finding out.
  //
  // Evaluated once per child, which is once per turn — the launcher
  // passes SOMORA_ACTIVE_MODEL per turn — so this tracks config
  // changes at the same rate the openai-compatible path does.
  for (const tool of await registry.listAvailable(ctx)) {
    if (!isToolAllowed(tool.name, tool.toolset, toolGating)) {
      logger.debug({ msg: 'mcp.tool_gated', agent, tool: tool.name });
      continue;
    }
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
        // Multimodal results forward as MCP-spec content array. MCP
        // supports `text` and `image` content types in tool results;
        // claude-agent-sdk and codex-cli pass these through to the
        // model natively. PDFs come in as image-blocks (rasterized
        // pages) because MCP has no `document` content type — the
        // file_read polymorph handles the rasterization upstream.
        if (result.contentBlocks) {
          return {
            content: result.contentBlocks.map((b) => {
              if (b.type === 'image') {
                return {
                  type: 'image' as const,
                  data: b.source.data,
                  mimeType: b.source.mediaType,
                };
              }
              if (b.type === 'document') {
                // Should not happen post-rasterization; defensive
                // fallback to text describing the gap.
                return {
                  type: 'text' as const,
                  text: `[document ${b.source.mediaType} — MCP cannot forward natively, this is a bug; tool should rasterize]`,
                };
              }
              return { type: 'text' as const, text: b.text };
            }),
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
  // Pass `agent` explicitly: in a multi-agent setup with several MCP
  // children alive at once, the parent-side forensics need to know which
  // agent's MCP just lost its peer. Without the tag, an engine-subprocess
  // crash is ambiguous across agents (jarvis 2026-05-13 incident).
  const shutdown = async (signal: string) => {
    logger.info({ msg: 'mcp.server_shutdown', agent, signal });
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
