// Tests for the failed-≠-empty REM handling (bug reports 2026-07-24 +
// follow-up 2026-07-25) and the Stage-0 referential validation in
// rem-dedup (report 2026-07-23).
//
// Run: npx tsx src/dream/rem-failure-handling.test.mts
//
// Covered:
//   1. extractFromSession vs. a backend that answers 200 with an error
//      body WITHOUT `choices` (omlx prefill-memory-guard shape) →
//      failedChunks=1, completed=true, real backend payload in the
//      thrown message (not "Cannot read properties of undefined").
//   2. extractFromSession happy path → findings parsed, failedChunks=0.
//   3. Abort mid-request (SIGTERM / user-activity path) → completed=false,
//      failedChunks=0 — the paused shape, NOT a masked-empty result.
//   4. applyRemDedup Stage-0: memory_edit against a non-existent slug is
//      downgraded to memory_write (with content) or dropped (without);
//      memory_delete against a non-existent slug is dropped; valid
//      memory_edit passes through. Runs even with dedup disabled.
//   5. storage: updateFindingStatus / dismissEntireDream record a
//      resolution_note; pruneFailedDreams keeps only the requested id.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point SOMORA_HOME at a temp dir BEFORE importing modules that compute
// paths from it at load time.
const HOME = join(tmpdir(), `somora-rem-fail-test-${process.pid}`);
process.env.SOMORA_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const { extractFromSession } = await import('./rem-extract.ts');
const { applyRemDedup } = await import('./rem-dedup.ts');
const {
  writeDreamFile,
  updateFindingStatus,
  dismissEntireDream,
  pruneFailedDreams,
  readDreamById,
  listDreams,
} = await import('./storage.ts');
const { dreamApply, dreamDismiss } = await import('../tools/dream/tools.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ── Mock openai-compatible backend ────────────────────────────────────
// mode switches per test: 'nochoices' | 'ok' | 'hang'
let mode: 'nochoices' | 'ok' | 'hang' = 'nochoices';
const hangingResponses: import('node:http').ServerResponse[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    if (mode === 'hang') {
      hangingResponses.push(res); // never respond
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (mode === 'nochoices') {
      // omlx guard-rejection shape: 200, JSON, no `choices`.
      res.end(
        JSON.stringify({
          error: { message: 'Prefill context too large for available memory (kv_len=23994)' },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        id: 'cmpl-test',
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify([
                {
                  action: 'memory_write',
                  slug: 'test-fact',
                  proposed_content: 'User said the test fact.',
                  reason: 'User stated it plainly.',
                },
              ]),
            },
          },
        ],
      }),
    );
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

function extractCtx(signal?: AbortSignal) {
  return {
    agent: 'testagent',
    events: [
      { ts: 1000, kind: 'user_message', text: 'hello, remember this test fact please' },
    ] as never[],
    existingMemory: [],
    referencedVault: [],
    workerModel: {
      providerName: 'fake',
      modelId: 'fake-model',
      provider: { engine: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x' },
      model: { id: 'fake-model' },
    } as never,
    chunkTimeoutMs: 10_000,
    chunkTokens: 50_000,
    signal,
  };
}

// ── 1. Error body without choices → failedChunks, not masked-empty ────
{
  mode = 'nochoices';
  const result = await extractFromSession(extractCtx() as never);
  check('nochoices: completed=true', result.completed === true);
  check('nochoices: failedChunks=1', result.failedChunks === 1, `${result.failedChunks}`);
  check('nochoices: no findings', result.findings.length === 0);
  check('nochoices: chunksProcessed counts through', result.chunksProcessed === 1);
}

// ── 2. Happy path → findings, failedChunks=0 ──────────────────────────
{
  mode = 'ok';
  const result = await extractFromSession(extractCtx() as never);
  check('ok: completed=true', result.completed === true);
  check('ok: failedChunks=0', result.failedChunks === 0, `${result.failedChunks}`);
  check('ok: one finding parsed', result.findings.length === 1, `${result.findings.length}`);
  check('ok: finding slug', result.findings[0]?.slug === 'test-fact');
}

// ── 3. Abort mid-request → completed=false (paused shape) ─────────────
{
  mode = 'hang';
  const ac = new AbortController();
  const p = extractFromSession(extractCtx(ac.signal) as never);
  setTimeout(() => ac.abort(), 300);
  const result = await p;
  check('abort: completed=false', result.completed === false);
  check('abort: failedChunks=0 (cancellation is not a failure)', result.failedChunks === 0, `${result.failedChunks}`);
  for (const res of hangingResponses.splice(0)) res.destroy();
}

// ── 4. rem-dedup Stage-0 referential validation ───────────────────────
{
  const stubMgr = {
    // No similarity hits — Stage 2 is not under test here.
    search: async () => [],
  } as never;
  const findings = [
    { id: 1, action: 'memory_edit', slug: 'wiki-hardware-fake-page', proposed_content: 'new body', reason: 'wiki edit disguised as memory_edit', status: 'pending' },
    { id: 2, action: 'memory_edit', slug: 'ghost-note', reason: 'edit without content', status: 'pending' },
    { id: 3, action: 'memory_delete', slug: 'never-existed', reason: 'delete of nothing', status: 'pending' },
    { id: 4, action: 'memory_edit', slug: 'real-note', proposed_content: 'update', reason: 'legit edit', status: 'pending' },
    { id: 5, action: 'memory_write', slug: 'brand-new', proposed_content: 'fresh', reason: 'new fact', status: 'pending' },
  ] as never[];
  const result = await applyRemDedup({
    agent: 'testagent',
    dreamId: 'test-dream',
    findings,
    existingMemorySlugs: ['real-note'],
    loadedWikiSlugs: ['hardware/fake-page'],
    mgr: stubMgr,
    config: { enabled: true, similarityThreshold: 0.85 } as never,
  });
  const bySlug = new Map(result.findings.map((f) => [f.slug, f]));
  check('stage0: edit w/ content on missing slug → downgraded to memory_write', bySlug.get('wiki-hardware-fake-page')?.action === 'memory_write');
  check('stage0: downgrade annotates reason', (bySlug.get('wiki-hardware-fake-page')?.reason ?? '').includes('auto-converted'));
  check('stage0: edit w/o content on missing slug → dropped', !bySlug.has('ghost-note'));
  check('stage0: delete on missing slug → dropped', !bySlug.has('never-existed'));
  check('stage0: legit edit passes through unchanged', bySlug.get('real-note')?.action === 'memory_edit');
  check('stage0: memory_write untouched', bySlug.get('brand-new')?.action === 'memory_write');
  check('stage0: counters', result.downgraded === 1 && result.dropped === 2, `downgraded=${result.downgraded} dropped=${result.dropped}`);

  // Validation must run even with dedup disabled.
  const disabled = await applyRemDedup({
    agent: 'testagent',
    dreamId: 'test-dream-2',
    findings: [
      { id: 1, action: 'memory_delete', slug: 'never-existed', reason: 'x', status: 'pending' },
      { id: 2, action: 'memory_write', slug: 'ok', proposed_content: 'y', reason: 'z', status: 'pending' },
    ] as never[],
    existingMemorySlugs: [],
    loadedWikiSlugs: [],
    mgr: stubMgr,
    config: { enabled: false, similarityThreshold: 0.85 } as never,
  });
  check('stage0 with dedup disabled: invalid delete still dropped', disabled.findings.length === 1 && disabled.findings[0]?.slug === 'ok');
}

// ── 5. storage: resolution_note + pruneFailedDreams ───────────────────
{
  const agent = 'testagent';
  const baseMeta = {
    agent,
    trigger: 'auto' as const,
    range_from_ts: 0,
    range_through_ts: 1000,
    created_at: new Date().toISOString(),
    chunks_done: 1,
    chunks_total: 1,
    worker_model_ref: 'fake/fake-model',
  };
  await writeDreamFile(agent, {
    meta: {
      ...baseMeta,
      id: 'd-note',
      source_session: 'sess-a',
      status: 'completed',
      findings: [
        { id: 1, action: 'memory_write', slug: 'a', proposed_content: 'x', reason: 'r', status: 'pending' },
        { id: 2, action: 'memory_write', slug: 'b', proposed_content: 'y', reason: 'r', status: 'pending' },
      ],
    },
    body: 'test',
  });
  await updateFindingStatus(agent, 'd-note', 1, 'dismissed', 'manually applied elsewhere');
  let d = await readDreamById(agent, 'd-note');
  check('updateFindingStatus records resolution_note', d?.meta.findings[0]?.resolution_note === 'manually applied elsewhere');
  check('updateFindingStatus leaves other findings unnoted', d?.meta.findings[1]?.resolution_note === undefined);

  await dismissEntireDream(agent, 'd-note', 'whole dream off-base');
  d = await readDreamById(agent, 'd-note');
  check('dismissEntireDream notes remaining pending finding', d?.meta.findings[1]?.resolution_note === 'whole dream off-base');
  check('dismissEntireDream keeps earlier note intact', d?.meta.findings[0]?.resolution_note === 'manually applied elsewhere');

  // pruneFailedDreams: three failed for sess-b, one for sess-c.
  for (const id of ['f-old-1', 'f-old-2', 'f-new']) {
    await writeDreamFile(agent, {
      meta: { ...baseMeta, id, source_session: 'sess-b', status: 'failed', findings: [], error: 'boom' },
      body: 'failed',
    });
  }
  await writeDreamFile(agent, {
    meta: { ...baseMeta, id: 'f-other', source_session: 'sess-c', status: 'failed', findings: [], error: 'boom' },
    body: 'failed',
  });
  const removed = await pruneFailedDreams(agent, 'sess-b', { keepId: 'f-new' });
  const after = await listDreams(agent);
  const failedIds = after.filter((x) => x.meta.status === 'failed').map((x) => x.meta.id).sort();
  check('prune removes older failed for the session', removed === 2, `${removed}`);
  check('prune keeps keepId + other sessions', failedIds.join(',') === 'f-new,f-other', failedIds.join(','));

  const removedAll = await pruneFailedDreams(agent, 'sess-b');
  const after2 = await listDreams(agent);
  check('prune without keepId clears the session entirely', removedAll === 1 && !after2.some((x) => x.meta.id === 'f-new'));
}

// ── 5b. resolved_manually terminal status (memory dreams) ─────────────
{
  const agent = 'testagent';
  const baseMeta = {
    agent,
    trigger: 'auto' as const,
    range_from_ts: 0,
    range_through_ts: 1000,
    created_at: new Date().toISOString(),
    chunks_done: 1,
    chunks_total: 1,
    worker_model_ref: 'fake/fake-model',
  };
  await writeDreamFile(agent, {
    meta: {
      ...baseMeta,
      id: 'd-resman',
      source_session: 'sess-r',
      status: 'completed',
      findings: [
        { id: 1, action: 'memory_write', slug: 'r1', proposed_content: 'x', reason: 'r', status: 'pending' },
        { id: 2, action: 'memory_write', slug: 'r2', proposed_content: 'y', reason: 'r', status: 'pending' },
      ],
    },
    body: 'test',
  });
  const ctx = { agent } as never;
  const single = (await dreamDismiss.handler(
    { dream_id: 'd-resman', finding_id: 1, reason: 'user updated the wiki page directly', resolved_manually: true },
    ctx,
  )) as Record<string, unknown>;
  check('dream_dismiss resolved_manually: result echoes status', single.status === 'resolved_manually');
  let d = await readDreamById(agent, 'd-resman');
  check('finding carries resolved_manually status', d?.meta.findings[0]?.status === 'resolved_manually');
  check('resolved_manually sets resolved_at', typeof d?.meta.findings[0]?.resolved_at === 'string');
  check('resolved_manually records note', d?.meta.findings[0]?.resolution_note === 'user updated the wiki page directly');
  check('other finding untouched', d?.meta.findings[1]?.status === 'pending');

  const whole = (await dreamDismiss.handler(
    { dream_id: 'd-resman', resolved_manually: true, reason: 'handled in chat' },
    ctx,
  )) as Record<string, unknown>;
  check('whole-dream resolved_manually: result status', whole.status === 'resolved_manually' && whole.dream_done === true);
  d = await readDreamById(agent, 'd-resman');
  check('whole-dream marks remaining finding resolved_manually', d?.meta.findings[1]?.status === 'resolved_manually');
  check('dream with only resolved_manually/mixed findings transitions to processed', d?.meta.status === 'processed');
}

// ── 6. dream_apply / dream_dismiss structured not-found ───────────────
{
  const ctx = { agent: 'testagent' } as never;
  const applyResult = (await dreamApply.handler({ dream_id: 'dummy', finding_id: 1 }, ctx)) as Record<string, unknown>;
  check('dream_apply unknown id: structured error', applyResult.error === 'dream_not_found');
  check('dream_apply unknown id: echoes requested id', applyResult.requested_id === 'dummy');
  check('dream_apply unknown id: valid_ids is array', Array.isArray(applyResult.valid_ids));
  check(
    'dream_apply unknown id: recommends dream_list when nothing pending',
    applyResult.recommended_next_tool === 'dream_list' || applyResult.recommended_next_tool === 'dream_get',
  );
  const dismissResult = (await dreamDismiss.handler({ dream_id: 'dummy' }, ctx)) as Record<string, unknown>;
  check('dream_dismiss unknown id: structured error', dismissResult.error === 'dream_not_found');
}

server.close();
rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
