// Top-level tools surface. Server constructs a single ToolRegistry,
// registers all groups, and hands ToolContext to each invocation.

export { ToolRegistry } from './registry.ts';
export type { ToolContext, ToolDefinition, ToolInvoker, ToolResult } from './types.ts';
export { memoryTools } from './memory/index.ts';
export { dreamTools } from './dream/index.ts';
export { timeTools } from './time/index.ts';
export { webTools } from './web/index.ts';
export { obsidianTools } from './obsidian/index.ts';
export { somoraDocsTools } from './docs/index.ts';
export { resourceTools } from './resources/index.ts';
export { fileTools } from './file/index.ts';
