// Moved unchanged from src/server/index.ts, which calls registerMcpRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import type { Context } from 'hono';

export interface McpRoutesDeps {
  mcpHub: typeof Server.mcpHub;
}

export function registerMcpRoutes(app: Hono, routeDeps: McpRoutesDeps): void {
  const { mcpHub } = routeDeps;
  // --- External MCP servers (hub) — design private/mcp-hub-design.md §4.5.
  // Behind the login key like every route (auth-key middleware); callers
  // on this machine send it through loopbackFetch.

  function mcpDisabled(c: Context) {
    return c.json(
      { error: 'no external MCP servers configured — add mcp.servers to ~/.somora/config.yaml' },
      503,
    );
  }

  app.get('/mcp/status', (c) => {
    if (!mcpHub.enabled) return mcpDisabled(c);
    return c.json({ enabled: true, servers: mcpHub.status() });
  });

  // Internal dispatch endpoint for the MCP-child proxy mode (and curl
  // debugging). Body: { server, tool (raw upstream name), args, timeoutMs? }.
  app.post('/mcp/call', async (c) => {
    if (!mcpHub.enabled) return mcpDisabled(c);
    const body = (await c.req.json().catch(() => null)) as {
      server?: string;
      tool?: string;
      args?: Record<string, unknown>;
      timeoutMs?: number;
    } | null;
    if (!body?.server || !body.tool) {
      return c.json({ error: 'server and tool are required' }, 400);
    }
    try {
      const result = await mcpHub.callTool(
        body.server,
        body.tool,
        body.args ?? {},
        typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.post('/mcp/servers/:name/reconnect', async (c) => {
    if (!mcpHub.enabled) return mcpDisabled(c);
    try {
      const status = await mcpHub.reconnect(c.req.param('name'));
      return c.json({ ok: true, status });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
