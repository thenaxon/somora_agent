// Deep is told WHEN a memory's content was stated.
// Run: npx tsx src/dream/deep-dates.test.mts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-deep-dates-'));
const { memoryDates } = await import('./deep-dispatcher.ts');
const { buildDeepSystemPrompt } = await import('./deep-prompts.ts');
const now = new Date('2026-09-21T12:00:00Z');

// A conversation from May, dreamed in September: the statement date leads.
let t = memoryDates({ frontmatter: { stated_at: '2026-05-12T09:00:00.000Z', created: '2026-09-21T10:00:00.000Z', updated: '2026-09-21T10:00:00.000Z' } }, now);
assert.match(t, /Today: 2026-09-21/);
assert.match(t, /stated on: 2026-05-12/);
assert.match(t, /written on: 2026-09-21/);
assert.ok(!/no statement date recorded/.test(t));

// A note the agent wrote itself: only the file dates exist, and that is said.
t = memoryDates({ frontmatter: { created: '2026-08-01T10:00:00.000Z' } }, now);
assert.match(t, /written on: 2026-08-01 — no statement date recorded/);
assert.ok(!/stated on/.test(t));

// gray-matter parses YAML dates into Date objects.
t = memoryDates({ frontmatter: { stated_at: new Date('2026-07-04T00:00:00Z') } }, now);
assert.match(t, /stated on: 2026-07-04/);

assert.match(memoryDates({ frontmatter: {} }, now), /Memory date: unknown/);
assert.match(memoryDates({}, now), /Memory date: unknown/);

const prompt = buildDeepSystemPrompt();
assert.match(prompt, /COMPARE DATES/);
assert.ok(!/treat new as more recent/.test(prompt), 'the blanket rule is gone');
console.log('deep-dates: all passed');
