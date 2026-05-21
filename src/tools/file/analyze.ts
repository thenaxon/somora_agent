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
import { z } from 'zod';
import { resolveAnyRef, type ResolvedModel } from '../../config/types.ts';
import { logger } from '../../server/logger.ts';
import { loadAttachment } from '../../multimodal/load.ts';
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

export const analyzeFile: ToolDefinition<z.infer<typeof AnalyzeInput>, AnalyzeOutput> = {
  name: 'analyze_file',
  toolset: 'file',
  description:
    'Analyze an image or PDF by dispatching it to a configured vision worker model. ' +
    'Returns the worker\'s text analysis — the agent never sees raw image bytes. Use ' +
    'this when:\n' +
    '  (a) The active main model lacks `image` or `pdf` capability (file_read on media ' +
    'will error with a hint pointing here);\n' +
    '  (b) You want a token-cheap summary instead of dropping a full image into context ' +
    '(1024×1024 image ≈ 1300 tokens; a haiku-worker description is usually < 200 tokens);\n' +
    '  (c) You need targeted visual questions ("which row is highest", "is there a stamp"). ' +
    'Pass an explicit `prompt` for those — the default is a generic "describe in detail".\n\n' +
    'Worker model is configured globally in `config.vision.worker` (and optional ' +
    '`config.vision.pdfWorker` override for PDFs). Returns an error if no worker is ' +
    'configured or the file type is unsupported. Image cap 5 MB, PDF cap 32 MB.',
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
  // Self-gate: hide the tool entirely when no vision worker is
  // configured. Otherwise the model sees `analyze_file` in its toolbox,
  // burns a turn calling it, and gets a "no vision worker configured"
  // error every single time. Same pattern as projects/wiki self-gating
  // (see [[feedback_opt_in_features_three_gates]]).
  available: (ctx) => Boolean(ctx.config.vision?.worker),
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
      att = await loadAttachment(absolute);
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

    // Pick worker: pdf-specific override if set & PDF, else default.
    const visionConfig = ctx.config.vision;
    const ref =
      att.mime.kind === 'pdf' ? (visionConfig.pdfWorker ?? visionConfig.worker) : visionConfig.worker;
    if (!ref) {
      throw new Error(
        `analyze_file: no vision worker configured. Set config.vision.worker ` +
          `(and optionally config.vision.pdfWorker) to a '<provider>/<modelId>' on an ` +
          `openai-compatible engine.`,
      );
    }

    const worker = resolveAnyRef(ctx.config, ref);
    if (!worker) {
      throw new Error(
        `analyze_file: configured vision worker '${ref}' does not resolve to a known model — ` +
          `fix config.yaml.`,
      );
    }
    const requiredCap = att.mime.kind === 'pdf' ? 'pdf' : 'image';
    if (!worker.model.capabilities.includes(requiredCap)) {
      throw new Error(
        `analyze_file: vision worker '${ref}' lacks '${requiredCap}' capability. ` +
          `Either configure a different worker (e.g. config.vision.pdfWorker for PDFs) ` +
          `or add the capability to the model definition if it actually supports it.`,
      );
    }

    const client = buildClient(worker);
    const content = toOpenAiContent(att, input.prompt);

    const start = Date.now();
    logger.info({
      msg: 'analyze_file.dispatch',
      agent: ctx.agent,
      session: ctx.session,
      worker: `${worker.providerName}/${worker.modelId}`,
      path: input.path,
      kind: att.mime.kind,
      size: att.size,
    });

    const completion = await client.chat.completions.create({
      model: worker.modelId,
      messages: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', content: content as any },
      ],
    });

    const text = completion.choices[0]?.message?.content;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error(
        `analyze_file: worker '${ref}' returned an empty response. Check provider logs.`,
      );
    }

    return {
      analysis: text,
      worker: `${worker.providerName}/${worker.modelId}`,
      mimeType: att.mime.mimeType,
      size: att.size,
      ms: Date.now() - start,
    };
  },
};

export function analyzeFileTools(): ToolDefinition[] {
  return [analyzeFile] as ToolDefinition[];
}
