// Catalog snapshot — the cross-process contract between the hub (main
// server, single writer) and the per-turn MCP child in proxy mode
// (reader). Design: private/mcp-hub-design.md §4.3.
//
// Single-writer means no lockfile protocol is needed (the sentinel
// store's lock exists because BOTH main server and child write there);
// atomic tmp+rename is enough for readers to never see a torn file.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredTool, McpServerStatus } from './manager.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const MCP_DIR = join(SOMORA_HOME, 'mcp');
export const CATALOG_PATH = join(MCP_DIR, 'catalog.json');

export interface CatalogServer {
  state: McpServerStatus['state'];
  tools: Array<{
    rawName: string;
    fullName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

export interface Catalog {
  version: 1;
  updatedAt: number;
  servers: Record<string, CatalogServer>;
}

export async function writeCatalog(
  status: Record<string, McpServerStatus>,
  tools: Map<string, DiscoveredTool[]>,
): Promise<void> {
  const servers: Record<string, CatalogServer> = {};
  for (const [name, st] of Object.entries(status)) {
    servers[name] = {
      state: st.state,
      tools: (tools.get(name) ?? []).map((t) => ({
        rawName: t.rawName,
        fullName: t.fullName,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }
  const catalog: Catalog = { version: 1, updatedAt: Date.now(), servers };
  if (!existsSync(MCP_DIR)) await mkdir(MCP_DIR, { recursive: true });
  const tmp = `${CATALOG_PATH}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await rename(tmp, CATALOG_PATH);
}

/** Reader side (MCP child proxy mode). Missing/corrupt file → null; the
 *  proxy then exposes zero tools instead of failing the CLI turn. */
export async function readCatalog(): Promise<Catalog | null> {
  try {
    const raw = await readFile(CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Catalog;
    if (parsed?.version !== 1 || typeof parsed.servers !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}
