// Registry bridge — turns the hub's discovered external tools into
// somora ToolDefinitions so the in-process engine path (openai-compat)
// sees them exactly like built-in tools. Design doc §4.2.
//
// Registration is dynamic: the hub calls refresh() whenever its catalog
// changes (connect, listChanged, disconnect). ToolRegistry.register is
// replace-on-name, and tools of disconnected servers stay registered but
// report available() === false — so the model never sees them, and we
// don't need a registry-remove primitive.

import { z } from 'zod';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { ToolDefinition } from '../../tools/types.ts';
import type { HubCallResult, McpHubManager } from './manager.ts';

/** External tools accept whatever object the model sends — argument
 *  validation is the upstream server's job (claude-code precedent:
 *  z.object({}).passthrough()). Non-objects still fail fast. */
const PASSTHROUGH_INPUT = z.object({}).passthrough();

export function bridgeMcpTools(manager: McpHubManager, registry: ToolRegistry): void {
  const registered = new Set<string>();

  const refresh = (): void => {
    for (const [server, tools] of manager.connectedTools()) {
      for (const tool of tools) {
        if (registered.has(tool.fullName)) continue;
        registered.add(tool.fullName);
        registry.register(buildDefinition(manager, server, tool.rawName, tool.fullName, tool));
      }
    }
  };

  manager.addCatalogListener(refresh);
  refresh();
}

function buildDefinition(
  manager: McpHubManager,
  server: string,
  rawName: string,
  fullName: string,
  tool: { description: string; inputSchema: Record<string, unknown> },
): ToolDefinition {
  const serverCfg = manager.serverConfig(server);
  return {
    name: fullName,
    description: tool.description || `Tool ${rawName} on MCP server ${server}.`,
    inputSchema: PASSTHROUGH_INPUT as z.ZodType<unknown>,
    jsonSchema: tool.inputSchema,
    toolset: 'mcp',
    origin: { mcpServer: server },
    ...(serverCfg?.maxResultChars ? { maxResultSizeChars: serverCfg.maxResultChars } : {}),
    // Engine-level per-call race: give the engine the same budget the
    // hub call gets, plus a 2s round-trip buffer.
    defaultTimeoutMs: (serverCfg?.timeoutMs ?? 60_000) + 2_000,
    // Hidden while the upstream server is anything but connected AND
    // while the tool vanished from a listChanged refetch.
    available: () => {
      const tools = manager.connectedTools().get(server);
      return tools !== undefined && tools.some((t) => t.fullName === fullName);
    },
    handler: async (input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>;
      const result = await manager.callTool(server, rawName, args);
      return mapHubResult(result);
    },
  };
}

/** Map a HubCallResult into what the registry expects from a handler:
 *  throw on upstream isError, multimodal shape when images are present,
 *  parsed JSON (or raw text) otherwise. */
export function mapHubResult(
  result: HubCallResult,
): unknown {
  if (result.isError) {
    throw new Error(result.text || 'MCP tool reported an error');
  }
  if (result.images.length > 0) {
    return {
      _somoraMultimodal: true as const,
      contentBlocks: [
        ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
        ...result.images.map((img) => ({
          type: 'image' as const,
          source: { kind: 'base64' as const, mediaType: img.mimeType, data: img.data },
        })),
      ],
    };
  }
  // Servers overwhelmingly return JSON-in-text; hand the model the
  // parsed object when it parses, the raw text otherwise.
  try {
    return JSON.parse(result.text);
  } catch {
    return result.text;
  }
}
