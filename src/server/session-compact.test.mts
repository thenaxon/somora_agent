// `/compact` by hand: each engine takes its own route, the outcome says
// what happened in words a client can show as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactSessionByHand, manualCompactionText, type ManualCompactionDeps } from './session-compact.ts';
import type { Config, ResolvedModel } from '../config/types.ts';
import type { Compaction } from '../compaction/index.ts';

const model = (engine: string): ResolvedModel =>
  ({ providerName: 'p', modelId: 'm', model: { id: 'm', capabilities: ['text'], contextWindow: 64000 }, provider: { engine } }) as unknown as ResolvedModel;

function deps(over: Partial<ManualCompactionDeps['engines']> = {}) {
  const meta: Record<string, unknown> = {};
  const calls: Record<string, unknown[]> = { run: [], claude: [], codex: [], grok: [] };
  const d: ManualCompactionDeps = {
    config: { providers: {}, compaction: {} } as unknown as Config,
    metaStore: {
      get: async () => ({ ...meta }),
      set: async (_a: string, _s: string, m: Record<string, unknown>) => void Object.assign(meta, m),
      update: async (_a: string, _s: string, fn: (m: Record<string, unknown>) => Record<string, unknown>) => {
        const next = fn({ ...meta });
        for (const k of Object.keys(meta)) delete meta[k];
        Object.assign(meta, next);
        return next;
      },
    } as unknown as ManualCompactionDeps['metaStore'],
    getHistory: async () => [],
    systemPrompt: async () => 'SYSTEM',
    engines: {
      runCompaction: async (input) => {
        calls.run!.push(input);
        return { ts: 1, throughTs: 1, summary: 's', byEngine: 'openai-compatible', byModel: 'p/m', tokensBefore: 12000, tokensAfter: 800, trigger: 'manual' } as Compaction;
      },
      claude: async (input) => {
        calls.claude!.push(input);
        return { status: 'compacted', tokensBefore: 17240, tokensAfter: 1490 };
      },
      codex: async (input) => {
        calls.codex!.push(input);
        return { status: 'compacted', tokensBefore: 24653 };
      },
      grok: async (input) => {
        calls.grok!.push(input);
        return { status: 'compacted', tokensBefore: 5498, tokensAfter: 4521 };
      },
      ...over,
    },
  };
  return { d, meta, calls };
}

const args = (engine: string, focus?: string) => ({ agent: 'ada', session: 'main', resolvedModel: model(engine), ...(focus ? { focus } : {}) });

test('openai-compatible: somora summarises with the focus and stores the compaction', async () => {
  const { d, meta, calls } = deps();
  const o = await compactSessionByHand(d, args('openai-compatible', 'keep every path'));
  assert.deepEqual(o, { status: 'compacted', engine: 'openai-compatible', tokensBefore: 12000, tokensAfter: 800 });
  assert.deepEqual((calls.run![0] as { manual: unknown }).manual, { focus: 'keep every path' });
  assert.equal((meta.compactions as Compaction[]).length, 1, 'the next turn sees the summary');
});

test('openai-compatible: too little conversation is said as such', async () => {
  const { d, meta } = deps({ runCompaction: async () => null });
  const o = await compactSessionByHand(d, args('openai-compatible'));
  assert.equal(o.status, 'nothing_to_compact');
  assert.match((o as { note: string }).note, /Too little conversation/);
  assert.equal(meta.compactions, undefined);
});

test('claude-cli: the focus goes to Claude as its instructions', async () => {
  const { d, calls } = deps();
  const o = await compactSessionByHand(d, args('claude-cli', 'keep the code word'));
  assert.deepEqual(o, { status: 'compacted', engine: 'claude-cli', tokensBefore: 17240, tokensAfter: 1490 });
  assert.equal((calls.claude![0] as { focus: string }).focus, 'keep the code word');
  assert.equal((calls.claude![0] as { systemPrompt: string }).systemPrompt, 'SYSTEM');
});

test('codex-cli: compacts, and says that a focus was not used', async () => {
  const { d } = deps();
  const withFocus = await compactSessionByHand(d, args('codex-cli', 'keep X'));
  assert.equal(withFocus.status, 'compacted');
  assert.match((withFocus as { note?: string }).note ?? '', /takes no instructions/);
  const without = await compactSessionByHand(d, args('codex-cli'));
  assert.equal((without as { note?: string }).note, undefined);
});

test('an engine without a thread yet has nothing to compact', async () => {
  const { d } = deps({ claude: async () => ({ status: 'nothing_to_compact', note: 'Claude has no conversation for this session yet.' }) });
  const o = await compactSessionByHand(d, args('claude-cli'));
  assert.deepEqual(o, { status: 'nothing_to_compact', engine: 'claude-cli', note: 'Claude has no conversation for this session yet.' });
});

test('grok-cli: compacts with sizes, and says that a focus was not used', async () => {
  const { d, calls } = deps();
  const o = await compactSessionByHand(d, args('grok-cli', 'keep X'));
  assert.deepEqual(o, { status: 'compacted', engine: 'grok-cli', tokensBefore: 5498, tokensAfter: 4521, note: 'Grok compacts by its own rules and takes no instructions: the focus was not used.' });
  assert.equal(calls.grok!.length, 1);
});

test('unknown engines are refused with a reason', async () => {
  const { d, calls } = deps();
  const o = await compactSessionByHand(d, args('acme-cli'));
  assert.deepEqual(o, { status: 'unsupported', engine: 'acme-cli', note: 'Compacting by hand is not available on the acme-cli engine.' });
  assert.equal(calls.run!.length + calls.claude!.length + calls.codex!.length + calls.grok!.length, 0);
});

test('the chat row reads well for each engine', () => {
  assert.equal(
    manualCompactionText({ status: 'compacted', engine: 'openai-compatible', tokensBefore: 12000, tokensAfter: 800 }, 'keep every path'),
    'Compacted by hand: somora summarised the earlier conversation (12.0k → 800 tokens). Focus: keep every path',
  );
  assert.equal(
    manualCompactionText({ status: 'compacted', engine: 'claude-cli', tokensBefore: 17240, tokensAfter: 1490 }),
    'Compacted by hand: Claude compacted its session (17.2k → 1.5k tokens).',
  );
  assert.equal(
    manualCompactionText({ status: 'compacted', engine: 'codex-cli', tokensBefore: 24653, note: 'Codex compacts by its own rules and takes no instructions: the focus was not used.' }, 'keep X'),
    'Compacted by hand: Codex compacted its session (was 24.7k tokens). Codex compacts by its own rules and takes no instructions: the focus was not used.',
  );
  assert.equal(
    manualCompactionText({ status: 'compacted', engine: 'grok-cli', tokensBefore: 5498, tokensAfter: 4521 }),
    'Compacted by hand: Grok compacted its session (5.5k → 4.5k tokens).',
  );
});

test('the focus reaches the summary prompt, and only when given', async () => {
  const { buildSummaryPrompt } = await import('../compaction/template.ts');
  const plain = buildSummaryPrompt({ systemPrompt: 'S', pairs: [{ user: 'u', assistant: 'a' }] });
  const focused = buildSummaryPrompt({ systemPrompt: 'S', pairs: [{ user: 'u', assistant: 'a' }], focus: 'keep paths' });
  assert.ok(!plain.user.includes('<focus>'));
  assert.ok(focused.user.includes('<focus>\nkeep paths\n</focus>'));
  assert.ok(focused.user.endsWith('Write the seven sections now.'));
});

test('a token count of zero is left out instead of shown', async () => {
  const { d } = deps({ codex: async () => ({ status: 'compacted', tokensBefore: 0 }) });
  const o = await compactSessionByHand(d, args('codex-cli'));
  assert.deepEqual(o, { status: 'compacted', engine: 'codex-cli' });
  assert.equal(manualCompactionText(o as never), 'Compacted by hand: Codex compacted its session.');
});
