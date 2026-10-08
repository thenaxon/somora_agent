// Compacting a session by hand (`/compact [focus]`, POST
// /agents/:agent/sessions/:session/compact). The automatic compaction
// runs before a turn when the context fills up; this one runs when a
// person asks, outside any turn, on the engine of the session's model:
//
//   openai-compatible  somora summarises (the same compaction as the
//                      automatic one), the focus goes into the prompt
//   claude-cli         Claude Code compacts its own session, the focus
//                      goes along as its instructions
//   codex-cli          Codex compacts its own thread; it takes no
//                      instructions, so a focus is reported as unused
//   anything else      not available
//
// The session file is never shortened; REM keeps reading all of it.

import type { Config, ResolvedModel } from '../config/types.ts';
import { listAllModels } from '../config/types.ts';
import { resolveCompactionConfig, type Compaction } from '../compaction/index.ts';
import { runCompaction } from '../compaction/summarize.ts';
import type { SessionMetaStore } from '../engine/types.ts';
import { compactClaudeSession } from '../engine/claude-cli.ts';
import { compactCodexThread } from '../engine/codex-cli.ts';
import { compactGrokSession } from '../engine/grok-cli.ts';
import type { NormalizedEvent } from '../types/events.ts';

export type ManualCompactionOutcome =
  | { status: 'compacted'; engine: string; tokensBefore?: number; tokensAfter?: number; note?: string }
  | { status: 'nothing_to_compact'; engine: string; note: string }
  | { status: 'unsupported'; engine: string; note: string };

export interface ManualCompactionDeps {
  config: Config;
  metaStore: SessionMetaStore;
  getHistory: (agent: string, session: string) => Promise<NormalizedEvent[]>;
  /** The system prompt the next turn would send; only read when needed. */
  systemPrompt: () => Promise<string>;
  /** Test seams. */
  engines?: {
    runCompaction?: typeof runCompaction;
    claude?: typeof compactClaudeSession;
    codex?: typeof compactCodexThread;
    grok?: typeof compactGrokSession;
  };
}

export async function compactSessionByHand(
  deps: ManualCompactionDeps,
  args: { agent: string; session: string; resolvedModel: ResolvedModel; focus?: string },
): Promise<ManualCompactionOutcome> {
  const { agent, session, resolvedModel } = args;
  const focus = args.focus?.trim() || undefined;
  const engine = resolvedModel.provider.engine;

  if (engine === 'openai-compatible') {
    const meta = (await deps.metaStore.get(agent, session)) as { compactions?: Compaction[] };
    const compaction = await (deps.engines?.runCompaction ?? runCompaction)({
      systemPrompt: await deps.systemPrompt(),
      history: await deps.getHistory(agent, session),
      resolvedModel,
      availableModels: listAllModels(deps.config),
      compactions: meta.compactions,
      config: resolveCompactionConfig(deps.config),
      manual: focus ? { focus } : {},
    });
    if (!compaction) {
      return {
        status: 'nothing_to_compact',
        engine,
        note: 'Too little conversation to compact yet: the last exchanges are always kept as they are.',
      };
    }
    await deps.metaStore.update(agent, session, (fresh) => ({
      ...fresh,
      compactions: [...(((fresh as { compactions?: Compaction[] }).compactions) ?? []), compaction],
    }));
    return {
      status: 'compacted',
      engine,
      ...(compaction.tokensBefore !== undefined ? { tokensBefore: compaction.tokensBefore } : {}),
      ...(compaction.tokensAfter !== undefined ? { tokensAfter: compaction.tokensAfter } : {}),
    };
  }

  if (engine === 'claude-cli') {
    const r = await (deps.engines?.claude ?? compactClaudeSession)({
      agent,
      session,
      resolvedModel,
      systemPrompt: await deps.systemPrompt(),
      metaStore: deps.metaStore,
      ...(focus ? { focus } : {}),
    });
    return r.status === 'compacted'
      ? { status: 'compacted', engine, ...pickTokens(r) }
      : { status: 'nothing_to_compact', engine, note: r.note ?? 'Claude did not compact.' };
  }

  if (engine === 'codex-cli') {
    const r = await (deps.engines?.codex ?? compactCodexThread)({
      agent,
      session,
      resolvedModel,
      metaStore: deps.metaStore,
    });
    if (r.status !== 'compacted') {
      return { status: 'nothing_to_compact', engine, note: r.note ?? 'Codex did not compact.' };
    }
    return {
      status: 'compacted',
      engine,
      ...pickTokens(r),
      ...(focus ? { note: 'Codex compacts by its own rules and takes no instructions: the focus was not used.' } : {}),
    };
  }

  if (engine === 'grok-cli') {
    const r = await (deps.engines?.grok ?? compactGrokSession)({
      agent,
      session,
      resolvedModel,
      metaStore: deps.metaStore,
    });
    if (r.status !== 'compacted') {
      return { status: 'nothing_to_compact', engine, note: r.note ?? 'Grok did not compact.' };
    }
    return {
      status: 'compacted',
      engine,
      ...pickTokens(r),
      ...(focus ? { note: 'Grok compacts by its own rules and takes no instructions: the focus was not used.' } : {}),
    };
  }

  return { status: 'unsupported', engine, note: `Compacting by hand is not available on the ${engine} engine.` };
}

function pickTokens(r: { tokensBefore?: number; tokensAfter?: number }): { tokensBefore?: number; tokensAfter?: number } {
  return {
    ...(typeof r.tokensBefore === 'number' && r.tokensBefore > 0 ? { tokensBefore: r.tokensBefore } : {}),
    ...(typeof r.tokensAfter === 'number' && r.tokensAfter > 0 ? { tokensAfter: r.tokensAfter } : {}),
  };
}

/** The chat row: what happened, in one line every client can show. */
export function manualCompactionText(o: Extract<ManualCompactionOutcome, { status: 'compacted' }>, focus?: string): string {
  const size =
    o.tokensBefore !== undefined && o.tokensAfter !== undefined
      ? ` (${formatTokens(o.tokensBefore)} → ${formatTokens(o.tokensAfter)} tokens)`
      : o.tokensBefore !== undefined
        ? ` (was ${formatTokens(o.tokensBefore)} tokens)`
        : '';
  const cli: Record<string, string> = { 'claude-cli': 'Claude', 'codex-cli': 'Codex', 'grok-cli': 'Grok' };
  const by = o.engine === 'openai-compatible' ? 'somora summarised the earlier conversation' : `${cli[o.engine] ?? o.engine} compacted its session`;
  return `Compacted by hand: ${by}${size}.${focus && !o.note ? ` Focus: ${focus}` : ''}${o.note ? ` ${o.note}` : ''}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
