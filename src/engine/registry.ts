import type { EngineName } from '../config/types.ts';
import { claudeCliEngine } from './claude-cli.ts';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import type { AgentEngine } from './types.ts';

export const engineRegistry: Record<EngineName, AgentEngine> = {
  'claude-cli': claudeCliEngine,
  'openai-compatible': openAiCompatibleEngine,
};
