// Tests for the per-turn image budget and the image tools' input
// contract (budget.ts, tools.ts).
//
// Run: npx tsx src/tools/image/budget.test.mts
//
// The case that matters most is the MCP one: a turn without an id must
// still be able to generate. Counting those against a session-derived
// key would produce a counter that never resets, and the agent would
// lose image generation for the rest of the session.

import assert from 'node:assert/strict';
import type { Config } from '../../config/types.ts';
import type { ToolContext } from '../types.ts';
import { imageGenerate, imageList } from './tools.ts';
import { checkImageBudget, imagesSpentInTurn, recordImagesInTurn, resetImageBudget } from './budget.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ── budget accounting ───────────────────────────────────────────────

resetImageBudget();
check('budget: fresh turn has spent nothing', imagesSpentInTurn('t1') === 0);
recordImagesInTurn('t1', 2);
check('budget: records accumulate', imagesSpentInTurn('t1') === 2);
recordImagesInTurn('t1', 1);
check('budget: second record adds', imagesSpentInTurn('t1') === 3);
check('budget: turns are independent', imagesSpentInTurn('t2') === 0);

resetImageBudget();
check('budget: first request fits', checkImageBudget('t1', 3, 5).ok);
recordImagesInTurn('t1', 3);
check('budget: remaining reported', checkImageBudget('t1', 1, 5).remaining === 2);
check('budget: request within remainder passes', checkImageBudget('t1', 2, 5).ok);

const over = checkImageBudget('t1', 3, 5);
check('budget: request over remainder refused', !over.ok);
check('budget: refusal states what was used', over.reason?.includes('3 of 5') === true, over.reason);
check(
  'budget: refusal tells the agent to ask',
  over.reason?.includes('Ask the user') === true,
  over.reason,
);

// A single call larger than the whole allowance is refused up front,
// before any turn accounting.
resetImageBudget();
const tooBig = checkImageBudget('t1', 9, 5);
check('budget: oversized single call refused', !tooBig.ok);
check(
  'budget: oversized refusal names the setting',
  tooBig.reason?.includes('maxImagesPerTurn') === true,
  tooBig.reason,
);
check('budget: refused call did not consume budget', imagesSpentInTurn('t1') === 0);

// Exactly at the ceiling is allowed; one past it is not.
resetImageBudget();
check('budget: exact ceiling allowed', checkImageBudget('t1', 5, 5).ok);
recordImagesInTurn('t1', 5);
check('budget: exhausted turn refuses one more', !checkImageBudget('t1', 1, 5).ok);
check('budget: exhausted turn reports zero remaining', checkImageBudget('t1', 1, 5).remaining === 0);

// ── the MCP case: no turn id ────────────────────────────────────────

resetImageBudget();
check('budget: untracked turn allows a normal call', checkImageBudget(undefined, 3, 5).ok);
check(
  'budget: untracked turn still enforces the per-call cap',
  !checkImageBudget(undefined, 6, 5).ok,
);
recordImagesInTurn(undefined, 4);
check(
  'budget: untracked calls never accumulate into a lockout',
  checkImageBudget(undefined, 5, 5).ok,
);
check('budget: untracked remaining is unbounded', checkImageBudget(undefined, 1, 5).remaining === Infinity);

// ── bookkeeping does not grow without bound ─────────────────────────

resetImageBudget();
for (let i = 0; i < 600; i++) recordImagesInTurn(`turn-${i}`, 1);
check('budget: oldest entries evicted', imagesSpentInTurn('turn-0') === 0);
check('budget: recent entries retained', imagesSpentInTurn('turn-599') === 1);

// ── availability gate ───────────────────────────────────────────────

function ctxWith(imageGen: unknown): ToolContext {
  return { agent: 'test', config: { imageGen } as unknown as Config } as ToolContext;
}

const enabled = ctxWith({ enabled: true, models: [{ name: 'm' }] });
check('gate: visible when enabled with a model', imageGenerate.available?.(enabled) === true);
check('gate: list tool follows the same gate', imageList.available?.(enabled) === true);
check(
  'gate: hidden when disabled',
  imageGenerate.available?.(ctxWith({ enabled: false, models: [{ name: 'm' }] })) === false,
);
check(
  'gate: hidden when enabled but no models',
  imageGenerate.available?.(ctxWith({ enabled: true, models: [] })) === false,
);
check('gate: hidden when block absent', imageGenerate.available?.(ctxWith(undefined)) === false);

// ── input contract ──────────────────────────────────────────────────

check('input: prompt required', !imageGenerate.inputSchema.safeParse({}).success);
check('input: bare prompt accepted', imageGenerate.inputSchema.safeParse({ prompt: 'x' }).success);
check(
  'input: empty prompt rejected',
  !imageGenerate.inputSchema.safeParse({ prompt: '' }).success,
);
check(
  'input: unknown fields rejected rather than silently dropped',
  !imageGenerate.inputSchema.safeParse({ prompt: 'x', aspectRatio: '16:9' }).success,
);
check(
  'input: n bounded',
  !imageGenerate.inputSchema.safeParse({ prompt: 'x', n: 11 }).success &&
    !imageGenerate.inputSchema.safeParse({ prompt: 'x', n: 0 }).success,
);
check(
  'input: compression bounded',
  !imageGenerate.inputSchema.safeParse({ prompt: 'x', output_compression: 101 }).success,
);
check(
  'input: full spec set accepted',
  imageGenerate.inputSchema.safeParse({
    prompt: 'ein Koala',
    model: 'grok-imagine',
    aspect_ratio: '16:9',
    resolution: '2K',
    quality: 'medium',
    n: 2,
    output_format: 'png',
    seed: 42,
    save_to: 'projekte/',
    return_image: true,
    extra: { vendor_flag: true },
  }).success,
);

// The JSON schema is hand-written alongside the zod schema; a field in
// one and not the other is invisible until an agent trips over it.
const jsonProps = Object.keys(
  (imageGenerate.jsonSchema as { properties: Record<string, unknown> }).properties,
);
const zodKeys = Object.keys(
  (imageGenerate.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
);
check(
  'schemas: json and zod expose the same fields',
  jsonProps.slice().sort().join() === zodKeys.slice().sort().join(),
  `json=${jsonProps.sort().join()} zod=${zodKeys.sort().join()}`,
);

const listJsonProps = Object.keys(
  (imageList.jsonSchema as { properties: Record<string, unknown> }).properties,
);
const listZodKeys = Object.keys(
  (imageList.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
);
check(
  'schemas: image_list json and zod agree',
  listJsonProps.slice().sort().join() === listZodKeys.slice().sort().join(),
  `json=${listJsonProps.sort().join()} zod=${listZodKeys.sort().join()}`,
);

check('input: list accepts no arguments', imageList.inputSchema.safeParse({}).success);
check(
  'input: list rejects a malformed date',
  !imageList.inputSchema.safeParse({ since: '26.08.2026' }).success,
);
check('input: list accepts an ISO date', imageList.inputSchema.safeParse({ since: '2026-08-26' }).success);

// ── declared metadata ───────────────────────────────────────────────

check('meta: generate is tagged image', imageGenerate.toolset === 'image');
// The listing sits in its own toolset on purpose: it covers both media,
// and hanging it off `image` left a video-only install unable to list
// what it had made. `tools: deny: [toolset:image]` must not take it.
check('meta: the listing is tagged media, not image', imageList.toolset === 'media');
check('meta: the listing is named for the question, not one medium',
  imageList.name === 'media_list');
// It used to return videos while called image_list. Either it filters
// or it is named for both — it is now named for both AND can filter.
check('input: the listing takes a type filter',
  imageList.inputSchema.safeParse({ type: 'video' }).success);
check('input: an invented type is rejected',
  !imageList.inputSchema.safeParse({ type: 'audio' }).success);
check(
  'meta: generate gets a timeout above the 30s default',
  (imageGenerate.defaultTimeoutMs ?? 0) >= 120_000,
);
check(
  'meta: description tells the agent the user already sees the image',
  imageGenerate.description.includes('chat automatically'),
);
check(
  'meta: description warns against putting specs in the prompt',
  imageGenerate.description.includes('Do NOT write them into the'),
);

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} image-tool test(s) failed`);
