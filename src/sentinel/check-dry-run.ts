// The dry run of a check (Sentinel phase 2, required before creating):
// run the script once as somora would — its own copy, a throwaway state
// folder, the same environment and limits — and, for Art 2, ask the
// decision model once. Nothing is kept, nobody is woken.
//
// A successful run is remembered on disk by the script's fingerprint, so
// creating the trigger can check that exactly this script was tried. On
// disk because claude-cli and codex-cli agents run each tool call in a
// separate process.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/types.ts';
import { judgeCheckData, judgeItems, type JudgeOutcome } from './check-judge.ts';
import { isEmptyData, itemKey, itemsOf, manyItemsWarning } from './check-logic.ts';
import { runCheck, type CheckAnswer } from './check-runner.ts';
import { installCheckScript, readCheckScript, removeCheckFiles } from './check-store.ts';
import type { CheckSource, Evaluator, Trigger } from './types.ts';

/** How long a dry run counts for creating the trigger. */
export const DRY_RUN_VALID_MS = 2 * 60 * 60 * 1000;

export interface DryRunReport {
  ok: boolean;
  art: 1 | 2;
  ms: number;
  /** What the script printed, as somora read it (secrets blacked out). */
  answer?: CheckAnswer;
  error?: string;
  errorClass?: 'temporary' | 'permanent';
  /** The end of stderr, for debugging the script. */
  stderr?: string;
  /** Art 2: the decision model's answer to the data. */
  decision?: JudgeOutcome;
  /** Art 2 with perItem: one answer per item (at most maxItemsPerCheck). */
  items?: Array<{ key: string; value?: number | string; wake?: boolean; error?: string }>;
  /** perItem: items over maxItemsPerCheck, left for later checks. */
  more?: number;
  /** Art 2 without perItem: the data is a list of several items. */
  warning?: string;
  /** What the first real check would do with this answer. */
  verdict: string;
}

function dryRunsPath(): string {
  return join(process.env.SOMORA_HOME ?? join(homedir(), '.somora'), 'sentinel', 'dry-runs.json');
}

type DryRunLog = Record<string, number>;
const key = (agent: string, sha: string, art: 1 | 2) => `${agent}:${art}:${sha}`;

async function readLog(): Promise<DryRunLog> {
  try {
    return JSON.parse(await readFile(dryRunsPath(), 'utf8')) as DryRunLog;
  } catch {
    return {};
  }
}

export async function recordDryRun(agent: string, sha: string, art: 1 | 2, now = Date.now()): Promise<void> {
  const log = await readLog();
  for (const [k, at] of Object.entries(log)) if (now - at > DRY_RUN_VALID_MS) delete log[k];
  log[key(agent, sha, art)] = now;
  const path = dryRunsPath();
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(log), { mode: 0o600 });
  await rename(tmp, path);
}

export async function hasRecentDryRun(agent: string, sha: string, art: 1 | 2, now = Date.now()): Promise<boolean> {
  const at = (await readLog())[key(agent, sha, art)];
  return at !== undefined && now - at <= DRY_RUN_VALID_MS;
}

function itemsVerdict(
  source: Pick<CheckSource, 'mode' | 'notifyOnFirst'>,
  items: NonNullable<DryRunReport['items']>,
  total: number,
  duplicates: number,
  more: number,
): string {
  if (total === 0) return 'no items — nothing to judge; the decision model is not asked.';
  const hits = items.filter((i) => i.wake).length;
  const failed = items.filter((i) => i.error).length;
  const parts = [`${items.length} item${items.length === 1 ? '' : 's'} judged one by one, ${hits} would wake`];
  if (failed) parts.push(`${failed} got no answer (at runtime asked again next check)`);
  if (more) parts.push(`${more} more over the limit of one check (config sentinel.checks.maxItemsPerCheck), judged at the next checks`);
  if (duplicates) parts.push(`${duplicates} item${duplicates === 1 ? '' : 's'} with the same id as another, judged once`);
  const first = source.mode === 'watch' && !source.notifyOnFirst
    ? ' A watch check\'s first real run only records these items as known; after that, each new item is judged like this, once, and wakes you with just the items above your rule.'
    : ' Each new item is judged once; a wake carries just the items above your rule.';
  return `${parts.join('; ')}.${first} An item is the same item next time by its "id" (or "key", "uid") field — give items one, or an item whose text changes counts as new.`;
}

function verdictFor(source: Pick<CheckSource, 'mode' | 'notifyOnFirst'>, art: 1 | 2, answer: CheckAnswer, decision?: JudgeOutcome): string {
  if (answer.final === 'failed') return 'final: "failed" — the first check would wake the agent at once and end the trigger.';
  if (art === 1) {
    if (source.mode === 'once') {
      return answer.ready
        ? 'ready: true — the first check would wake the agent at once and the trigger would be done. If the condition does not hold right now, the script reads the data wrongly: fetch the data yourself (exec curl, read the file), compare, fix and dry-run again.'
        : 'ready: false — the trigger would keep checking and wake on the first ready: true (or at the deadline).';
    }
    if (source.notifyOnFirst) return answer.ready ? 'ready: true — with notifyOnFirst the first check wakes the agent.' : 'ready: false — no wake; it wakes when ready turns true.';
    return answer.ready
      ? 'ready: true ALREADY — a watch check only wakes when ready changes from false to true, so while this stays true it never wakes. If the condition does not hold right now, the script reads the data wrongly: fetch the data yourself (exec curl, read the file), compare field names and values, fix the script and dry-run again.'
      : 'ready: false — a watch check\'s first run only records this as the starting state; it wakes when ready changes from false to true.';
  }
  if (isEmptyData(answer.data)) return 'data is empty — nothing to judge; the decision model is not asked for empty data.';
  if (!decision) return '';
  if (!decision.ok) return `the decision model could not answer (${decision.error}) — at runtime that is a check error, never a wake.`;
  const would = decision.wake ? 'would wake' : 'would not wake';
  const first = source.mode === 'watch' && !source.notifyOnFirst
    ? ' A watch check\'s first real run only records the data as its starting state; after that, new data is judged like this.'
    : '';
  return `${decision.question} = ${decision.value} (${decision.detail ?? ''}) — this data ${would}.${first}`;
}

/** Run a script once. `scriptPath` is the agent's file (resolved and
 *  allowed by the caller); `installed` re-runs an existing trigger's copy. */
export async function dryRunCheck(args: {
  agent: string;
  source: Pick<CheckSource, 'mode' | 'notifyOnFirst' | 'timeoutMs'>;
  evaluator: Evaluator;
  config: Config;
  scriptPath?: string;
  installed?: Trigger;
}): Promise<DryRunReport & { sha?: string }> {
  const art: 1 | 2 = args.evaluator.type === 'decision' ? 2 : 1;
  const limits = args.config.sentinel.checks;
  const timeoutMs = Math.min(args.source.timeoutMs ?? limits.timeoutMs, limits.maxTimeoutMs);
  // Always a throwaway id: its own copy and an empty state folder. A
  // trigger's real state folder is never touched — a mail script that
  // marks mails as seen during a test would make the real check miss them.
  const tempId = `dry-${randomBytes(6).toString('hex')}`;
  const triggerId = tempId;
  let script: CheckSource['script'];
  try {
    if (args.installed && args.installed.source.type === 'check') {
      const copy = await readCheckScript(args.installed.id, args.installed.source.script.file, args.installed.source.script.sha256);
      if (!copy.ok) return { ok: false, art, ms: 0, error: copy.error, errorClass: 'permanent', verdict: 'the trigger cannot run its script — update it with a new one.' };
      script = await installCheckScript(tempId, copy.path);
    } else if (args.scriptPath) {
      script = await installCheckScript(tempId, args.scriptPath);
    } else {
      return { ok: false, art, ms: 0, error: 'no script given', verdict: '' };
    }
    const run = await runCheck({ triggerId, agent: args.agent, script, art, timeoutMs, maxOutputBytes: limits.maxOutputBytes, config: args.config });
    const stderr = run.stderr.trim() ? run.stderr.trim().slice(-1500) : undefined;
    if (!run.ok) {
      return { ok: false, art, ms: run.ms, error: run.error, errorClass: run.errorClass, ...(stderr ? { stderr } : {}), verdict: 'a check error — never a wake; three in a row pause the trigger.', sha: script.sha256 };
    }
    const asTrigger = { id: args.installed?.id ?? 'dry-run', evaluator: args.evaluator } as Trigger;
    if (args.evaluator.type === 'decision' && args.evaluator.perItem) {
      const all = itemsOf(run.answer.data).map((item) => ({ key: itemKey(item), item }));
      const unique = all.filter((i, n) => all.findIndex((j) => j.key === i.key) === n);
      const asked = unique.slice(0, limits.maxItemsPerCheck);
      const results = asked.length ? await judgeItems(asTrigger, asked, args.config, limits.parallelDecisions) : [];
      const items = results.map((r) => (r.outcome.ok ? { key: r.key, value: r.outcome.value, wake: r.outcome.wake } : { key: r.key, error: r.outcome.error }));
      const more = unique.length - asked.length;
      return {
        ok: true,
        art,
        ms: run.ms,
        answer: run.answer,
        ...(stderr ? { stderr } : {}),
        items,
        ...(more > 0 ? { more } : {}),
        verdict: itemsVerdict(args.source, items, unique.length, all.length - unique.length, more),
        sha: script.sha256,
      };
    }
    let decision: JudgeOutcome | undefined;
    if (art === 2 && !isEmptyData(run.answer.data)) {
      decision = await judgeCheckData(asTrigger, run.answer.data, args.config);
    }
    const warning = art === 2 ? manyItemsWarning(run.answer.data) : undefined;
    return {
      ok: true,
      art,
      ms: run.ms,
      answer: run.answer,
      ...(stderr ? { stderr } : {}),
      ...(decision ? { decision } : {}),
      ...(warning ? { warning } : {}),
      verdict: verdictFor(args.source, art, run.answer, decision),
      sha: script.sha256,
    };
  } finally {
    await removeCheckFiles(tempId).catch(() => {});
  }
}
