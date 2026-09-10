// `analyze_file` tool — dispatch a path to a configured vision worker
// model and return its text analysis. Works regardless of the active
// main-model's capabilities, which is the point: lets a text-only
// agent (local omlx, etc.) still reason about images and PDFs by
// outsourcing the visual layer.
//
// Worker is configured globally in `config.vision.{worker, pdfWorker}`.
// PDF dispatches use `pdfWorker` if set, else fall back to `worker`.
// Both workers must be on `openai-compatible` engine in v1 (same
// constraint as Dream-Mode) — Anthropic-direct support is future work.
//
// See `private/skills-design.md`-adjacent vision discussion + the
// model-capability gating in `file_read` for the polymorphic complement.

import OpenAI from 'openai';
import { createPatientOpenAIClient } from '../../server/openai-client.ts';
import { userTagParam } from '../../engine/user-tag.ts';
import { z } from 'zod';
import { workerChain, resolveAnyRef, type Config, type ResolvedModel } from '../../config/types.ts';
import { logger } from '../../server/logger.ts';
import { loadAttachment, type LoadedAttachment } from '../../multimodal/load.ts';
import { samplingBody } from '../../engine/sampling.ts';
import { toOpenAiContent } from '../../multimodal/blocks.ts';
import { checkReadAllowed, realpathSafeAncestor, resolveLocalPath } from './policy.ts';
import type { ToolDefinition } from '../types.ts';

const AnalyzeInput = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Absolute or workspace-relative path to the file. Image (PNG/JPEG/WebP/GIF) or PDF.',
      ),
    prompt: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe(
        'What to ask the vision worker about the file. Defaults to a generic ' +
          '"describe in detail" prompt — set explicitly for focused questions ' +
          '("which row of the table has the highest value?", "is there a logo present?").',
      ),
  })
  .strict();

interface AnalyzeOutput {
  /** The vision worker's text answer. */
  analysis: string;
  /** Which model was used for this dispatch (provider/modelId). */
  worker: string;
  /** MIME type detected on the file. */
  mimeType: string;
  /** Bytes read. */
  size: number;
  /** Wall-clock time the worker call took. */
  ms: number;
}

function buildClient(model: ResolvedModel): OpenAI {
  if (model.provider.engine !== 'openai-compatible') {
    throw new Error(
      `vision worker '${model.providerName}/${model.modelId}' is on engine ` +
        `'${model.provider.engine}'; only openai-compatible workers are supported in v1. ` +
        `Use openrouter or another openai-compatible proxy if you want a Claude/GPT model.`,
    );
  }
  return createPatientOpenAIClient({
    baseURL: model.provider.baseUrl,
    apiKey: model.provider.apiKey,
  });
}

/**
 * Workers that just failed, and until when they stay skipped. Module
 * scope on purpose: this is per somora process, shared across agents,
 * because a GPU box being in the wrong profile is not an agent-specific
 * fact. Without it, every call pays the full timeout again.
 */
const failedUntil = new Map<string, number>();

export const analyzeFile: ToolDefinition<z.infer<typeof AnalyzeInput>, AnalyzeOutput> = {
  name: 'analyze_file',
  toolset: 'file',
  description:
    'Look at an image or PDF you cannot see yourself. Your active model has no `image` ' +
    'capability, so somora dispatches the file to a configured vision worker model and ' +
    'returns its text description — you never see raw image bytes. ' +
    'Pass an explicit `prompt` for targeted questions ("which row is highest", "is there ' +
    'a stamp"); the default is a generic "describe in detail". ' +
    'A described image is a second-hand account: quote what the worker reported, do not ' +
    'claim to have seen the file yourself.\n\n' +
    'Worker model is configured globally in `config.vision.worker` (and optional ' +
    '`config.vision.pdfWorker` override for PDFs). Returns an error if the file type is ' +
    'unsupported. Image cap 5 MB, PDF cap 32 MB.',
  inputSchema: AnalyzeInput,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or workspace-relative path.' },
      prompt: {
        type: 'string',
        description: 'What to ask about the file. Defaults to "describe in detail".',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  // Self-gate, two conditions.
  //
  // No vision worker configured: hide it, or the model burns a turn
  // calling a tool that can only answer "no worker configured". Same
  // pattern as projects/wiki self-gating.
  //
  // Active model can see images itself: hide it too (Rene 2026-09-10).
  // The worker is a SUBSTITUTE for models without vision, not a cheaper
  // route for models with it. Measured before this gate: 142 dispatches
  // in the live logs, 67 of them with a failing worker, and every one
  // of them from an agent whose own model has the `image` capability.
  // A tool the model never sees is a tool it cannot pick by mistake.
  // PDFs ride along: file_read rasterises them to images, so `image`
  // capability is enough to look at one.
  available: (ctx) => {
    if (!ctx.config.vision?.worker) return false;
    const caps = ctx.activeModel?.model.capabilities;
    // No active model (debug invoke, tests): leave it available.
    return !caps?.includes('image');
  },
  defaultTimeoutMs: 120_000,
  async handler(input, ctx): Promise<AnalyzeOutput> {
    // Resolve the path through the same pipeline file_read uses: expand
    // `~/`, resolve workspace-relative against the agent's workspace,
    // and apply the read-blacklist + realpath ancestor check. Without
    // this, `analyze_file` was the lone file-touching tool that ignored
    // the policy layer — it could see paths file_read would block.
    const { absolute } = await resolveLocalPath(input.path, ctx.agent, ctx.config);
    const policy = checkReadAllowed(absolute);
    if (!policy.ok) throw new Error(policy.reason);
    const real = await realpathSafeAncestor(absolute);
    const policyReal = checkReadAllowed(real);
    if (!policyReal.ok) throw new Error(policyReal.reason);
    let att;
    try {
      // Honour config.attachments caps. Without them the loader falls back
      // to its built-in 5 MB image default (Anthropic's ceiling), so an
      // operator who raised maxImageBytes for their own 2K/4K imageGen
      // output still got refused here — analyze_file was the one path
      // that ignored the setting (feedback 2026-09-01).
      att = await loadAttachment(absolute, {
        maxImageBytes: ctx.config.attachments.maxImageBytes,
        maxPdfBytes: ctx.config.attachments.maxPdfBytes,
        maxTextBytes: ctx.config.attachments.maxTextBytes,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new Error(`analyze_file: file_not_found at '${absolute}'`);
      }
      throw err;
    }
    if (att.mime.kind !== 'image' && att.mime.kind !== 'pdf') {
      throw new Error(
        `analyze_file: '${input.path}' is ${att.mime.kind} (${att.mime.mimeType}); ` +
          `this tool handles image and pdf only. Use file_read for text.`,
      );
    }

    let result;
    try {
      result = await describeMedia({
        att,
        prompt: input.prompt,
        config: ctx.config,
        agent: ctx.agent,
        ...(ctx.session ? { session: ctx.session } : {}),
        caller: 'analyze_file',
      });
    } catch (err) {
      // The shared helper serves two callers, so it does not know whose
      // name belongs in front of the message. Here it is the tool's.
      throw new Error(`analyze_file: ${(err as Error).message}`);
    }
    return {
      analysis: result.analysis,
      worker: result.worker,
      ...(result.fellBackFrom ? { fellBackFrom: result.fellBackFrom } : {}),
      mimeType: result.mimeType,
      size: result.size,
      ms: result.ms,
    };
  },
};

export interface VisionDescription {
  analysis: string;
  /** `<provider>/<modelId>` of the worker that answered. */
  worker: string;
  /** Workers passed over before this one, with the reason. */
  fellBackFrom?: string[];
  mimeType: string;
  size: number;
  ms: number;
}

/**
 * Run one image or PDF through the configured worker chain and return
 * the first answer. Shared by `analyze_file` and by the chat path,
 * which reaches for a worker when the agent's own model cannot see an
 * attachment — one chain, one budget, one set of log lines.
 *
 * Two budgets apply. `timeoutMs` bounds a single attempt, and
 * `totalBudgetMs` bounds the whole chain: each attempt gets whatever is
 * left, and a worker that could not finish in the remaining time is not
 * started at all. Before that budget existed, four workers of a chain
 * could spend four full timeouts in a row while the caller waited.
 */
export async function describeMedia(args: {
  att: LoadedAttachment;
  prompt?: string;
  config: Config;
  agent: string;
  session?: string;
  caller: 'analyze_file' | 'chat_attachment';
}): Promise<VisionDescription> {
  const { att, config, agent, caller } = args;
  const visionConfig = config.vision;
  // Pick the chain: the pdf-specific one if set and this is a PDF,
  // otherwise the general one.
  const chain = workerChain(
    att.mime.kind === 'pdf' ? (visionConfig.pdfWorker ?? visionConfig.worker) : visionConfig.worker,
  );
  if (chain.length === 0) {
    throw new Error(
      `no vision worker configured. Set config.vision.worker ` +
        `(and optionally config.vision.pdfWorker) to a '<provider>/<modelId>' on an ` +
        `openai-compatible engine.`,
    );
  }
  const requiredCap = att.mime.kind === 'pdf' ? 'pdf' : 'image';
  const content = toOpenAiContent(att, args.prompt);
  const start = Date.now();
  const deadline = start + visionConfig.totalBudgetMs;

  // Try in order; the first worker that answers wins. Availability
  // only — a worker that replies with nonsense has still answered,
  // and which model is good enough is the operator's decision, not
  // something this tool should second-guess.
  const skipped: string[] = [];
  let attempts = 0;
  for (const ref of chain) {
    const worker = resolveAnyRef(config, ref);
    if (!worker) {
      skipped.push(`${ref}: not a known model in config.yaml`);
      continue;
    }
    if (!worker.model.capabilities.includes(requiredCap)) {
      skipped.push(`${ref}: lacks '${requiredCap}' capability`);
      continue;
    }
    const cooling = failedUntil.get(ref);
    if (cooling !== undefined && cooling > Date.now()) {
      skipped.push(`${ref}: failed recently, still cooling down`);
      continue;
    }
    // What is left of the chain budget. Starting an attempt that cannot
    // finish only delays the error the caller is going to get anyway.
    const remaining = deadline - Date.now();
    if (remaining < 2_000) {
      skipped.push(`${ref}: chain budget spent (vision.totalBudgetMs ${visionConfig.totalBudgetMs} ms)`);
      continue;
    }
    const attemptMs = Math.min(visionConfig.timeoutMs, remaining);

    attempts += 1;
    const label = `${worker.providerName}/${worker.modelId}`;
    logger.info({
      msg: 'analyze_file.dispatch',
      agent,
      session: args.session,
      caller,
      worker: label,
      ref,
      attempt: attempts,
      chainLength: chain.length,
      attemptMs,
    });
    try {
      const completion = await buildClient(worker).chat.completions.create(
        {
          model: worker.modelId,
          messages: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { role: 'user', content: content as any },
          ],
          // A caption is not a chat answer. The worker model's own cap
          // is a chat cap (16k and up is normal), which lets a reasoning
          // worker think its way past the timeout while writing three
          // lines about a screenshot. vision.maxOutputTokens is the
          // budget for THIS job; sampling stays the model's own.
          max_tokens: visionConfig.maxOutputTokens,
          ...samplingBody(worker.model.sampling),
          ...userTagParam(worker, agent, 'analyze_file'),
        },
        { signal: AbortSignal.timeout(attemptMs) },
      );
      const text = completion.choices[0]?.message?.content;
      if (typeof text !== 'string' || text.length === 0) {
        // An empty answer with a length stop is a worker that spent the
        // whole budget thinking. Say so: it reads as a model choice
        // problem, not as a broken connection.
        const stop = completion.choices[0]?.finish_reason;
        throw new Error(
          stop === 'length'
            ? `worker produced no text within ${visionConfig.maxOutputTokens} output tokens (finish_reason=length) — raise vision.maxOutputTokens or use a worker that does not think first`
            : 'worker returned an empty response',
        );
      }
      failedUntil.delete(ref);
      if (attempts > 1 || skipped.length > 0) {
        // Worth a line of its own: a chain that has quietly settled
        // on its external last resort is a running cost nobody
        // notices otherwise.
        logger.warn({
          msg: 'analyze_file.fell_back',
          agent,
          worker: label,
          skipped,
        });
      }
      return {
        analysis: text,
        worker: label,
        ...(skipped.length > 0 ? { fellBackFrom: skipped } : {}),
        mimeType: att.mime.mimeType,
        size: att.size,
        ms: Date.now() - start,
      };
    } catch (err) {
      const reason = (err as Error).message;
      // Slow is not dead. A worker that ran out of time may have been
      // loading a model or handed a very large picture; a connection
      // error means it is not there at all. Cool them down differently
      // so one slow answer does not sideline a good worker.
      const timedOut = isTimeout(err);
      const cooldown = timedOut ? visionConfig.timeoutCooldownMs : visionConfig.healthCacheMs;
      if (cooldown > 0) failedUntil.set(ref, Date.now() + cooldown);
      logger.warn({
        msg: 'analyze_file.worker_failed',
        agent,
        worker: label,
        ref,
        timedOut,
        cooldownMs: cooldown,
        err: reason,
      });
      skipped.push(`${ref}: ${timedOut ? `no answer within ${attemptMs} ms` : reason}`);
    }
  }

  // Nothing in the chain worked. Name every entry and why it was
  // passed over — "no vision worker available" alone would send the
  // operator hunting through logs for something this already knows.
  throw new Error(
    `no vision worker could handle this ${att.mime.kind} within ${Date.now() - start} ms. Tried:\n` +
      skipped.map((s2) => `  - ${s2}`).join('\n'),
  );
}

/** An aborted attempt, however the client dressed it up. */
function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed? ?out|aborted/i.test(e?.message ?? '');
}

export function analyzeFileTools(): ToolDefinition[] {
  return [analyzeFile] as ToolDefinition[];
}
