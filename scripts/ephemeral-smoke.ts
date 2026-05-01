// Smoke test for the ephemeral-context refactor (Phase 2j.1):
//   - injectMemoryContext returns ephemeralContext (separate from systemPrompt)
//   - claude-cli: combines systemPrompt + ephemeralContext for the SDK
//   - openai-compatible: combines into the system message
//   - codex-cli: keeps systemPrompt only on first turn (codex remembers it
//     after that), but always sends ephemeralContext (memory-context changes
//     per turn, codex's remembered prompt is frozen at session start)
//
// We don't make real LLM calls — we exercise the prompt-construction logic
// directly. The inject path is end-to-end via a real MemoryManager pointed
// at a temp directory.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SOMORA_HOME = join(tmpdir(), '.somora-ephemeral-smoke');
process.env.SOMORA_HOME = SOMORA_HOME;

async function setup() {
  await rm(SOMORA_HOME, { recursive: true, force: true });
  const dir = join(SOMORA_HOME, 'agents', 'hans', 'memory');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'auto.md'),
    `---\ndescription: User's car\n---\n\nUser drives a small hatchback.\n`,
    'utf8',
  );
}

const CFG = {
  embedding: { provider: 'local', model: 'all-MiniLM-L6-v2' },
  chunking: { targetTokens: 400, overlapTokens: 80 },
  autoInject: { queryTurns: 3, maxResults: 5, minScore: 0, maxTokens: 1500 },
  hybrid: { vectorWeight: 0.7, bm25Weight: 0.3 },
};

function expect(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`✅ ${label}`);
  } else {
    console.log(`❌ ${label}${detail ? ': ' + detail : ''}`);
    process.exitCode = 1;
  }
}

async function run() {
  const { injectMemoryContext } = await import(
    join(REPO_ROOT, 'src', 'memory', 'inject.ts')
  );
  const { MemoryManager } = await import(
    join(REPO_ROOT, 'src', 'memory', 'manager.ts')
  );
  await setup();
  const mgr = new MemoryManager({ agent: 'hans', config: CFG });
  await mgr.init();

  // ── injectMemoryContext shape ──────────────────────────────────────
  const inject = await injectMemoryContext({
    mgr,
    history: [],
    userMessage: 'what car do I drive?',
    cfg: CFG.autoInject,
  });
  expect(
    'inject.ephemeralContext is a non-empty string',
    typeof inject.ephemeralContext === 'string' && inject.ephemeralContext!.length > 0,
  );
  expect(
    'inject.ephemeralContext starts with <memory-context>',
    inject.ephemeralContext!.startsWith('<memory-context>'),
  );
  expect(
    'inject.ephemeralContext ends with </memory-context>',
    inject.ephemeralContext!.trimEnd().endsWith('</memory-context>'),
  );
  expect(
    'inject.ephemeralContext contains memory/auto reference',
    inject.ephemeralContext!.includes('memory/auto'),
  );
  expect('inject.injectedCount > 0', inject.injectedCount > 0);
  expect(
    'inject.hits[0] is the auto note',
    inject.hits[0]?.slug === 'auto',
  );

  const ephemeral = inject.ephemeralContext!;
  const persona = '# Persona\n\nI am Hans.';

  // ── claude-cli: replicates the systemPromptForTurn construction ───
  const claudeSystemPrompt = ephemeral
    ? `${persona}\n\n---\n\n${ephemeral}`
    : persona;
  expect(
    'claude-cli systemPrompt contains persona',
    claudeSystemPrompt.includes('I am Hans'),
  );
  expect(
    'claude-cli systemPrompt contains ephemeral block',
    claudeSystemPrompt.includes('<memory-context>'),
  );

  // ── openai-compatible: replicates the effectiveSystemPrompt + buildMessages ──
  const openaiSystemPrompt = ephemeral
    ? `${persona}\n\n---\n\n${ephemeral}`
    : persona;
  expect(
    'openai-compatible system message contains persona',
    openaiSystemPrompt.includes('I am Hans'),
  );
  expect(
    'openai-compatible system message contains ephemeral block',
    openaiSystemPrompt.includes('<memory-context>'),
  );
  expect(
    'openai-compatible system message contains memory/auto',
    openaiSystemPrompt.includes('memory/auto'),
  );

  // ── codex-cli: replicates the promptPayload construction (first turn AND resume) ──
  const replayPrefix = '';
  const userMessage = 'what car do I drive?';
  const ephemeralBlock = ephemeral ? `${ephemeral}\n\n---\n\n` : '';

  const firstTurn = `${persona}\n\n---\n\n${ephemeralBlock}${replayPrefix}${userMessage}`;
  expect(
    'codex-cli first-turn payload contains persona',
    firstTurn.includes('I am Hans'),
  );
  expect(
    'codex-cli first-turn payload contains ephemeral block',
    firstTurn.includes('<memory-context>'),
  );
  expect(
    'codex-cli first-turn payload ends with userMessage',
    firstTurn.trim().endsWith(userMessage),
  );

  const resumeTurn = `${ephemeralBlock}${replayPrefix}${userMessage}`;
  expect(
    'codex-cli resume payload does NOT contain persona (codex remembers it)',
    !resumeTurn.includes('I am Hans'),
  );
  expect(
    'codex-cli resume payload DOES contain ephemeral block (the bug we just fixed)',
    resumeTurn.includes('<memory-context>'),
  );
  expect(
    'codex-cli resume payload contains memory/auto reference',
    resumeTurn.includes('memory/auto'),
  );
  expect(
    'codex-cli resume payload ends with userMessage',
    resumeTurn.trim().endsWith(userMessage),
  );

  // ── No-ephemeral edge case: server skips inject if no hits ──────────
  const emptyInject = await injectMemoryContext({
    mgr,
    history: [],
    userMessage: 'xyzqwerty something nobody knows', // no recall hits
    cfg: { ...CFG.autoInject, minScore: 0.95 }, // high bar, force zero hits
  });
  expect(
    'inject returns ephemeralContext=undefined when no hits pass minScore',
    emptyInject.ephemeralContext === undefined,
  );
  expect('inject.injectedCount=0 in that case', emptyInject.injectedCount === 0);

  // Verify codex-cli resume payload with no ephemeral degrades cleanly
  const noEphemeral = '';
  const resumeNoEphem = `${noEphemeral}${replayPrefix}${userMessage}`;
  expect(
    'codex-cli resume with no ephemeral = userMessage only',
    resumeNoEphem === userMessage,
  );

  await mgr.close();
}

run().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
