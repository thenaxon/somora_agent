// Worker chains: config shapes and normalisation (2026-08-27).
// Run: npx tsx src/config/worker-chain.test.mts
//
// `vision.worker` used to be one string and is now either a string or
// an ordered list. The old shape has to keep parsing — a config change
// that silently invalidates every existing config.yaml is not an
// improvement — and both shapes have to reach the runtime as the same
// list, because the dispatch loop should not care which was written.

import { VisionConfigSchema, workerChain, ImageModelSchema } from './types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}

// ── normalisation ──────────────────────────────────────────────────
check('unset → empty chain', workerChain(undefined).length === 0);
check('a string → one-element chain', JSON.stringify(workerChain('a/b')) === '["a/b"]');
check('a list stays in order', JSON.stringify(workerChain(['a', 'b', 'c'])) === '["a","b","c"]');

// ── the old shape still parses ─────────────────────────────────────
{
  const old = VisionConfigSchema.parse({ worker: 'openrouter/some-vision-model' });
  check('string form accepted', old.worker === 'openrouter/some-vision-model');
  check('string form normalises to a chain', workerChain(old.worker).length === 1);
}

// ── the new shape ──────────────────────────────────────────────────
{
  const chained = VisionConfigSchema.parse({
    worker: ['local/qwen-vision', 'local/other-vision', 'openrouter/hosted-vision'],
    pdfWorker: 'openrouter/hosted-vision',
  });
  check('list form accepted', workerChain(chained.worker).length === 3);
  check('list keeps local-first order', workerChain(chained.worker)[0] === 'local/qwen-vision');
  check('pdfWorker may still be a bare string', workerChain(chained.pdfWorker).length === 1);
}

// ── defaults exist so the dispatch loop can rely on them ───────────
{
  const empty = VisionConfigSchema.parse({});
  check('timeoutMs has a default', typeof empty.timeoutMs === 'number' && empty.timeoutMs > 0);
  check('healthCacheMs has a default', typeof empty.healthCacheMs === 'number');
  check('no worker configured is legal', workerChain(empty.worker).length === 0);
}

// ── an empty list is a config mistake, not "no worker" ─────────────
check('empty list rejected', !VisionConfigSchema.safeParse({ worker: [] }).success);
check('empty string rejected', !VisionConfigSchema.safeParse({ worker: '' }).success);

// ── image models: the fallback field ───────────────────────────────
{
  const m = ImageModelSchema.parse({ name: 'primary', provider: 'p', model: 'm', fallback: 'backup' });
  check('image model takes a fallback handle', m.fallback === 'backup');
  check('image model wire defaults to openrouter', m.wire === 'openrouter');
  check('image model editEndpoint has a default', m.editEndpoint === '/images/edits');
  const plain = ImageModelSchema.parse({ name: 'solo', provider: 'p', model: 'm' });
  check('fallback is optional', plain.fallback === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
