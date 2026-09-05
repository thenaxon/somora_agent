// somora tools → Codex app-server dynamic tools (design §3.4).
//
// Codex treats dynamic tools as first-class: per-tool `deferLoading`,
// namespaces, and a direct-only namespace list in
// `features.code_mode.direct_only_tool_namespaces`. That is what MCP tools
// never got (always deferred, absent from Code Mode's ALL_TOOLS —
// 2026-09-05 report). Rules:
//
//   - Namespaces only. A top-level tool named `exec` collides with Codex's
//     own code-mode `exec` (verified 2026-09-05: the model could not call
//     it); inside `somora` it is `somora.exec` and works on every model.
//   - `somora`         every regular tool; deferLoading = !direct set.
//   - `somora_direct`  tools whose results carry images. Listed as a
//                      direct-only namespace so Code Mode does not flatten
//                      the image to text.
//   - `somora_mcp_<server>`  external hub tools. Codex reserves dynamic
//                      tool names `mcp` / `mcp__*`, and the registry names
//                      them `mcp__<server>__<tool>`; the namespace carries
//                      the server, the tool keeps its raw name, and
//                      resolve() maps back to the registry name. Nothing
//                      outside this engine sees the renamed shape.

import type { ToolDefinition, ToolResult } from '../tools/types.ts';

export const CODEX_NS = 'somora';
export const CODEX_DIRECT_NS = 'somora_direct';
export const CODEX_MCP_NS_PREFIX = 'somora_mcp_';

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const NAME_MAX = 128;

/** Tools kept in the model's direct tool list (schemas in context). The
 *  rest is deferred behind Codex tool search / Code Mode discovery.
 *  Overridable via config `codexCli.directTools`. */
export const DEFAULT_CODEX_DIRECT_TOOLS: readonly string[] = [
  'memory_search',
  'memory_get',
  'memory_write',
  'memory_edit',
  'file_read',
  'file_write',
  'file_patch',
  'file_list',
  'file_search',
  'exec',
  'tmux',
  'web_search',
  'web_fetch',
  'time_now',
  'agent_ask',
  'spawn_subagent',
  'subagent_result',
  'somora_docs_list',
  'somora_docs_read',
];

/** Tools whose ToolResult may carry image content blocks. */
export const CODEX_MULTIMODAL_RESULT_TOOLS: ReadonlySet<string> = new Set([
  'file_read',
  'image_generate',
]);

export interface CodexDynamicFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
}

export interface CodexDynamicNamespaceSpec {
  type: 'namespace';
  name: string;
  description: string;
  tools: CodexDynamicFunctionSpec[];
}

export type CodexDynamicToolSpec = CodexDynamicFunctionSpec | CodexDynamicNamespaceSpec;

export interface CodexToolCatalog {
  specs: CodexDynamicToolSpec[];
  /** Namespaces Codex must keep directly model-visible. */
  directOnlyNamespaces: string[];
  /** Registry names that are deferred (for the developer-instruction hint). */
  deferredNames: string[];
  directNames: string[];
  /** Registry names that could not be projected (invalid names). */
  skipped: Array<{ name: string; reason: string }>;
  /** (namespace, tool) as Codex calls it → registry tool name. */
  resolve(namespace: string | null | undefined, tool: string): string | undefined;
}

const MCP_RE = /^mcp__([^_].*?)__(.+)$/;

export function buildCodexToolCatalog(
  tools: readonly ToolDefinition[],
  directTools: readonly string[] = DEFAULT_CODEX_DIRECT_TOOLS,
): CodexToolCatalog {
  const direct = new Set(directTools);
  const regular: CodexDynamicFunctionSpec[] = [];
  const directOnly: CodexDynamicFunctionSpec[] = [];
  const perServer = new Map<string, CodexDynamicFunctionSpec[]>();
  const lookup = new Map<string, string>();
  const deferredNames: string[] = [];
  const directNames: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const tool of tools) {
    const mcp = MCP_RE.exec(tool.name);
    let ns: string;
    let exposedName: string;
    if (mcp) {
      const server = mcp[1]!;
      exposedName = mcp[2]!;
      ns = `${CODEX_MCP_NS_PREFIX}${server}`;
    } else if (CODEX_MULTIMODAL_RESULT_TOOLS.has(tool.name)) {
      ns = CODEX_DIRECT_NS;
      exposedName = tool.name;
    } else {
      ns = CODEX_NS;
      exposedName = tool.name;
    }
    if (!NAME_RE.test(exposedName) || exposedName.length > NAME_MAX || !NAME_RE.test(ns)) {
      skipped.push({ name: tool.name, reason: 'name outside ^[a-zA-Z0-9_-]+$ or too long' });
      continue;
    }
    const isDirect = direct.has(tool.name) || ns === CODEX_DIRECT_NS;
    const spec: CodexDynamicFunctionSpec = {
      type: 'function',
      name: exposedName,
      description: tool.description,
      inputSchema: tool.jsonSchema,
      ...(isDirect ? {} : { deferLoading: true }),
    };
    lookup.set(`${ns}.${exposedName}`, tool.name);
    (isDirect ? directNames : deferredNames).push(tool.name);
    if (ns === CODEX_NS) regular.push(spec);
    else if (ns === CODEX_DIRECT_NS) directOnly.push(spec);
    else {
      const list = perServer.get(ns) ?? [];
      list.push(spec);
      perServer.set(ns, list);
    }
  }

  const specs: CodexDynamicToolSpec[] = [];
  if (regular.length > 0) {
    specs.push({ type: 'namespace', name: CODEX_NS, description: 'somora agent tools', tools: regular });
  }
  if (directOnly.length > 0) {
    specs.push({
      type: 'namespace',
      name: CODEX_DIRECT_NS,
      description: 'somora tools whose results can contain images',
      tools: directOnly,
    });
  }
  for (const [ns, list] of [...perServer.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    specs.push({
      type: 'namespace',
      name: ns,
      description: `external MCP server ${ns.slice(CODEX_MCP_NS_PREFIX.length)} (via somora)`,
      tools: list,
    });
  }
  deferredNames.sort();
  directNames.sort();
  return {
    specs,
    directOnlyNamespaces: directOnly.length > 0 ? [CODEX_DIRECT_NS] : [],
    deferredNames,
    directNames,
    skipped,
    resolve: (namespace, tool) => {
      if (namespace) return lookup.get(`${namespace}.${tool}`);
      // Codex may drop the namespace for direct tools; fall back to the
      // regular namespace, then any unique match.
      const direct = lookup.get(`${CODEX_NS}.${tool}`) ?? lookup.get(`${CODEX_DIRECT_NS}.${tool}`);
      if (direct) return direct;
      const hits = [...lookup.entries()].filter(([k]) => k.endsWith(`.${tool}`));
      return hits.length === 1 ? hits[0]![1] : undefined;
    },
  };
}

/** Developer-instruction paragraph (OpenClaw pattern): names of the
 *  deferred tools + how to reach them on every Codex model mode. */
export function codexToolGuidance(catalog: CodexToolCatalog): string {
  const lines = [
    `Your somora tools are dynamic tools in the \`${CODEX_NS}\` namespace (external MCP servers: \`${CODEX_MCP_NS_PREFIX}<server>\`). ` +
      'They run on the somora server with the same permissions as on every other engine.',
  ];
  if (catalog.deferredNames.length > 0) {
    lines.push(
      `Deferred (searchable) somora tools, absent from the direct tool list: ${catalog.deferredNames.join(', ')}. ` +
        'Use `tool_search` when it is directly callable. On code-mode-only models use `exec` instead: ' +
        'filter `ALL_TOOLS` by name and description, then call the matching entry through `tools`.',
    );
  }
  return lines.join('\n');
}

export interface CodexToolCallResponse {
  contentItems: Array<
    { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }
  >;
  success: boolean;
}

/** ToolResult → item/tool/call response. */
export function toolResultToCodexResponse(result: ToolResult): CodexToolCallResponse {
  if (!result.ok) {
    return {
      contentItems: [{ type: 'inputText', text: result.error ?? 'tool failed' }],
      success: false,
    };
  }
  if (result.contentBlocks && result.contentBlocks.length > 0) {
    const items: CodexToolCallResponse['contentItems'] = [];
    for (const b of result.contentBlocks) {
      if (b.type === 'image') {
        items.push({ type: 'inputImage', imageUrl: `data:${b.source.mediaType};base64,${b.source.data}` });
      } else if (b.type === 'text') {
        items.push({ type: 'inputText', text: b.text });
      } else {
        items.push({
          type: 'inputText',
          text: `[document ${b.source.mediaType} omitted — Codex dynamic tools carry text and images only]`,
        });
      }
    }
    return { contentItems: items, success: true };
  }
  return {
    contentItems: [{ type: 'inputText', text: JSON.stringify(result.data ?? null) }],
    success: true,
  };
}
