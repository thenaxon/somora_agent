import type { ToolDefinition } from '../types.ts';
import { browserTool } from './tools.ts';

export function browserTools(): ToolDefinition[] {
  return [browserTool as unknown as ToolDefinition];
}
