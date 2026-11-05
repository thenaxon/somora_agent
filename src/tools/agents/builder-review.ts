// builder_review — the orderer's verdict on a builder's acceptance list.
//
// The builder keeps one item per requirement with its evidence
// (acceptance_write) but never accepts its own work. The person reviews
// in the task panel; the agent that gave the order reviews here. Only
// that agent: the server checks it against the session's orderer (the
// agent of the latest order — builder_dispatch or agent_ask). The
// pattern follows the reviewer tools of other harnesses: a verdict per
// item, a rejection always with its reason, and rejected work goes back
// to the one who did it (docs/builder.md "Reviewing the list").
//
// accepted needs a note saying what the reviewer ran and saw: a check
// without a command and its output is a reading, not a verification.
// rejected needs the reason; the item counts as open for the builder
// until it sends it again with new evidence, and by default the
// rejections are sent into the builder's session as one message.

import { z } from 'zod';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ToolDefinition } from '../types.ts';
import { agentAsk } from './ask.ts';

const NOTE_MIN = 12;

const Item = z
  .object({
    id: z.string().min(1).describe('Item id from the list, e.g. A02.'),
    verdict: z.enum(['accepted', 'rejected']).describe('accepted or rejected.'),
    note: z
      .string()
      .min(NOTE_MIN)
      .max(1000)
      .describe(
        'accepted: what you ran yourself and what you saw ("ran pytest tests/test_x.py -k profile → 3 passed; marker in request"). ' +
          'rejected: what is wrong or missing, so the builder can fix it.',
      ),
  })
  .strict();

const Input = z
  .object({
    builder: z.string().min(1).describe('The builder agent whose list you review.'),
    session: z.string().min(1).describe('The builder session (from builder_dispatch or the agent_ask result).'),
    items: z.array(Item).min(1).max(60).describe('One verdict per item you checked. Items you leave out stay unreviewed.'),
    send_back: z
      .boolean()
      .optional()
      .describe('Default true: rejected items are sent into the builder session as one message, so it fixes them and reports again. false: only record the verdicts.'),
  })
  .strict();

type ReviewInput = z.infer<typeof Input>;

function baseUrl(): string {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
}

async function postReview(builder: string, session: string, body: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  let res;
  try {
    res = await loopbackFetch(`${baseUrl()}/agents/${encodeURIComponent(builder)}/sessions/${encodeURIComponent(session)}/acceptance/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const c = classifyFetchError(err);
    throw new Error(`builder_review [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? { ok: true } : { ok: false, error: data.error ?? `HTTP ${res.status}` };
}

/** The message a builder gets for rejected items. */
export function composeSendBack(reviewer: string, rejected: ReadonlyArray<{ id: string; note: string }>): string {
  return [
    `[review] ${reviewer} rejected ${rejected.length} item(s) of your acceptance list:`,
    ...rejected.map((r) => `- ${r.id}: ${r.note}`),
    '',
    'Fix what each note names, verify it again, and send the rejected item with acceptance_write with the new evidence (that clears the rejection). ' +
      'Every other item goes as id and status only, so it keeps its evidence and review — new evidence on an accepted item would undo the acceptance. ' +
      'If a note is wrong, say why with evidence instead of changing the item. Then end with your complete report again.',
  ].join('\n');
}

export const builderReview: ToolDefinition<ReviewInput> = {
  name: 'builder_review',
  toolset: 'agents',
  description:
    'Review the acceptance list of a builder you gave an order to (builder_dispatch or agent_ask): accept or reject items. ' +
    'Only the agent of the latest order in that session may. Accept only what you checked yourself: the note names the ' +
    'command you ran and what you saw — re-run two or three of the builder\'s own evidence commands, the builder\'s word ' +
    'is a claim. A suite result is context, not evidence for a requirement it does not exercise. Reject with the reason; ' +
    'rejected items count as open for the builder and, unless send_back is false, go to its session as one message ' +
    '(you are woken with its next report). The person can override any verdict in the task panel.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      builder: { type: 'string', description: 'The builder agent whose list you review.' },
      session: { type: 'string', description: 'The builder session (from builder_dispatch or the agent_ask result).' },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        description: 'One verdict per item you checked. Items you leave out stay unreviewed.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Item id from the list, e.g. A02.' },
            verdict: { type: 'string', enum: ['accepted', 'rejected'], description: 'accepted or rejected.' },
            note: {
              type: 'string',
              minLength: NOTE_MIN,
              maxLength: 1000,
              description: 'accepted: what you ran yourself and what you saw. rejected: what is wrong or missing.',
            },
          },
          required: ['id', 'verdict', 'note'],
          additionalProperties: false,
        },
      },
      send_back: { type: 'boolean', description: 'Default true: rejected items go to the builder session as one message. false: only record.' },
    },
    required: ['builder', 'session', 'items'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 60_000,
  async handler(input, ctx) {
    if (input.builder === ctx.agent) throw new Error('builder_review: a builder does not review its own work');
    const done: Array<{ id: string; verdict: string }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const item of input.items) {
      const r = await postReview(input.builder, input.session, { id: item.id, verdict: item.verdict, note: item.note, by_agent: ctx.agent });
      if (r.ok) done.push({ id: item.id, verdict: item.verdict });
      else {
        // Not the orderer, or no such session: every item would fail
        // the same way — stop at the first.
        if (/reviews this list|not found|is not a builder/.test(r.error) && done.length === 0) throw new Error(`builder_review: ${r.error}`);
        failed.push({ id: item.id, error: r.error });
      }
    }
    const rejected = input.items.filter((i) => i.verdict === 'rejected' && done.some((d) => d.id === i.id));
    let sentBack: unknown;
    if (rejected.length > 0 && input.send_back !== false) {
      sentBack = await agentAsk.handler(
        {
          agent: input.builder,
          session: input.session,
          message: composeSendBack(ctx.agent, rejected),
          wait: false,
        } as Parameters<typeof agentAsk.handler>[0],
        ctx,
      );
    }
    return {
      ok: failed.length === 0,
      builder: input.builder,
      session: input.session,
      accepted: done.filter((d) => d.verdict === 'accepted').map((d) => d.id),
      rejected: done.filter((d) => d.verdict === 'rejected').map((d) => d.id),
      ...(failed.length > 0 ? { failed } : {}),
      ...(sentBack !== undefined ? { sent_back: sentBack } : {}),
      note:
        rejected.length > 0 && input.send_back !== false
          ? 'The rejected items went to the builder as one message; you are woken with its next report. Review the items it sends again.'
          : rejected.length > 0
            ? 'Rejections recorded, nothing sent. The builder sees them as open items when it next works in that session.'
            : 'Verdicts recorded.',
    };
  },
};
