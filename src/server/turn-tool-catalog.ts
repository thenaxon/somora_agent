// The tool catalog (src/tools/catalog.ts) for one turn: config.yaml
// `toolCatalog`, the agent's kind, whether it holds the review loop and
// the tools the turn offers go in; out comes a function the engine asks
// with the model that actually answers — a fallback model may run on
// another engine, and per-engine and per-model patches follow it.

import type { Config, ResolvedModel } from '../config/types.ts';
import { isLoopHolder } from '../dream/loop-state.ts';
import { alwaysVisibleTools } from '../tools/catalog.ts';
import { logger } from './logger.ts';

let legacyLogged = false;

export function turnAlwaysVisible(args: {
  config: Pick<Config, 'toolCatalog' | 'codexCli'>;
  agent: string;
  kind: 'chat' | 'builder' | undefined;
  offered: readonly string[];
}): (model: ResolvedModel) => string[] {
  const legacy = args.config.codexCli?.directTools;
  if (legacy && !legacyLogged) {
    legacyLogged = true;
    logger.info({
      msg: 'tool_catalog.legacy_codex_direct_tools',
      hint: 'codexCli.directTools replaces the toolCatalog list for codex-cli; move it to toolCatalog (docs/tools.md).',
    });
  }
  const inReviewLoop = isLoopHolder(args.agent);
  return (model) =>
    alwaysVisibleTools(args.offered, {
      kind: args.kind ?? 'chat',
      inReviewLoop,
      engine: model.provider.engine,
      modelRefs: [`${model.providerName}/${model.modelId}`, ...(model.model.alias ? [model.model.alias] : [])],
      catalog: args.config.toolCatalog,
      ...(legacy ? { legacyCodexDirect: legacy } : {}),
    });
}
