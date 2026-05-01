// Top-level tools surface. Server constructs a single ToolRegistry,
// registers all groups, and hands ToolContext to each invocation.

export { ToolRegistry } from './registry.ts';
export type { ToolContext, ToolDefinition, ToolInvoker, ToolResult } from './types.ts';
export { memoryTools } from './memory/index.ts';
export { dreamTools } from './dream/index.ts';
