// Lucid single-run orchestrator. Loads the full wiki, sends to Opus
// with the Lucid system prompt, parses findings, persists.
//
// Cluster strategy (per private/dream-system-v2.md):
//   < 300 pages → single-pass (current implementation)
//   300-1500   → subfolder pass + cross-subfolder pass (deferred)
//   > 1500     → hierarchical (deferred)
//
// Output: a LucidRun written to ~/.somora/wiki-lucid/<id>.json that
// the dream tools (dream_list/get/apply/dismiss) surface to the user
// for approval.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config, ResolvedModel } from '../config/types.ts';
import { resolveAnyRef } from '../config/types.ts';
import { resolveObsidianSource } from '../memory/registry.ts';
import { logger } from '../server/logger.ts';
import { callOneShotLLM } from './deep-llm.ts';
import { LUCID_SYSTEM_PROMPT } from './lucid-prompt.ts';
import { setRunStatus, writeLucidRun } from './lucid-storage.ts';
import type {
  LucidFinding,
  LucidFindingKind,
  LucidFix,
  LucidRun,
} from './lucid-types.ts';

export interface RunLucidArgs {
  config: Config;
  trigger: 'auto' | 'manual';
  signal?: AbortSignal;
}

export interface RunLucidResult {
  runId: string;
  findingsCount: number;
  pagesScanned: number;
  durationMs: number;
  status: LucidRun['status'];
}

export async function runLucid(args: RunLucidArgs): Promise<RunLucidResult> {
  const start = Date.now();
  const id = makeRunId(args.trigger);

  // Resolve worker model.
  const ref = args.config.wiki.lucid.model;
  if (!ref) {
    return failedRun(id, args.trigger, start, 0, 'no worker model configured for lucid');
  }
  const workerModel = resolveAnyRef(args.config, ref);
  if (!workerModel) {
    return failedRun(id, args.trigger, start, 0, `worker model '${ref}' did not resolve`);
  }

  // Resolve wiki root.
  const obs = resolveObsidianSource(args.config.obsidian);
  if (!obs?.vaultPath) {
    return failedRun(id, args.trigger, start, 0, 'no vault configured');
  }
  const wikiAbs = join(obs.vaultPath, args.config.wiki.vaultSubfolder);

  // Load all wiki pages + index.
  const { indexContent, pages, pagesScanned } = await loadFullWiki(wikiAbs);

  if (pagesScanned === 0) {
    return failedRun(id, args.trigger, start, 0, 'wiki is empty — no pages to lucid-scan');
  }

  logger.info({
    msg: 'dream.lucid.start',
    id,
    trigger: args.trigger,
    pagesScanned,
    workerModel: `${workerModel.providerName}/${workerModel.modelId}`,
  });

  // Persist a running record so failures leave a trace.
  const run: LucidRun = {
    id,
    status: 'running',
    created_at: new Date(start).toISOString(),
    trigger: args.trigger,
    pages_scanned: pagesScanned,
    worker_model_ref: `${workerModel.providerName}/${workerModel.modelId}`,
    findings: [],
  };
  await writeLucidRun(run);

  const userMsg = buildUserMessage(indexContent, pages);
  const estTokens = Math.ceil((LUCID_SYSTEM_PROMPT.length + userMsg.length) / 4);
  run.estimated_tokens = estTokens;
  logger.info({
    msg: 'dream.lucid.llm_request',
    id,
    estimatedTokensIn: estTokens,
    pagesScanned,
  });

  let llmText: string;
  try {
    llmText = await callOneShotLLM({
      workerModel,
      systemPrompt: LUCID_SYSTEM_PROMPT,
      userMessage: userMsg,
      timeoutMs: 600_000,
      ...(args.signal ? { signal: args.signal } : {}),
      logCtx: { agent: 'lucid', op: 'lucid', slug: id },
    });
  } catch (err) {
    return failedRun(id, args.trigger, start, pagesScanned, (err as Error).message);
  }

  const findings = parseLucidFindings(llmText, id);
  run.findings = findings;
  setRunStatus(run, 'completed');
  await writeLucidRun(run);

  logger.info({
    msg: 'dream.lucid.done',
    id,
    trigger: args.trigger,
    findingsCount: findings.length,
    pagesScanned,
    durationMs: Date.now() - start,
    byKind: countByKind(findings),
  });

  return {
    runId: id,
    findingsCount: findings.length,
    pagesScanned,
    durationMs: Date.now() - start,
    status: 'completed',
  };
}

function failedRun(
  id: string,
  trigger: 'auto' | 'manual',
  start: number,
  pagesScanned: number,
  error: string,
): RunLucidResult {
  logger.error({ msg: 'dream.lucid.failed', id, error });
  const run: LucidRun = {
    id,
    status: 'failed',
    created_at: new Date(start).toISOString(),
    trigger,
    pages_scanned: pagesScanned,
    worker_model_ref: '',
    findings: [],
    error,
  };
  void writeLucidRun(run).catch(() => {});
  return {
    runId: id,
    findingsCount: 0,
    pagesScanned,
    durationMs: Date.now() - start,
    status: 'failed',
  };
}

// ─── wiki loading ───────────────────────────────────────────────────

async function loadFullWiki(wikiAbs: string): Promise<{
  indexContent: string;
  pages: Array<{ wikiPath: string; markdown: string }>;
  pagesScanned: number;
}> {
  let indexContent = '';
  try {
    indexContent = await readFile(join(wikiAbs, 'index.md'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ msg: 'dream.lucid.index_read_failed', err: (err as Error).message });
    }
    indexContent = '(no index.md)';
  }

  const pages: Array<{ wikiPath: string; markdown: string }> = [];
  await walkPages(wikiAbs, '', pages);
  return { indexContent, pages, pagesScanned: pages.length };
}

async function walkPages(
  rootAbs: string,
  relPath: string,
  out: Array<{ wikiPath: string; markdown: string }>,
): Promise<void> {
  const dir = relPath ? join(rootAbs, relPath) : rootAbs;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'logs' || e.name === 'index.md') continue;
    const sub = relPath ? `${relPath}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walkPages(rootAbs, sub, out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const full = join(rootAbs, sub);
      try {
        const md = await readFile(full, 'utf8');
        const wikiPath = sub.replace(/\.md$/, '');
        out.push({ wikiPath, markdown: md });
      } catch (err) {
        logger.warn({
          msg: 'dream.lucid.page_unreadable',
          path: full,
          err: (err as Error).message,
        });
      }
    }
  }
}

// ─── prompt-building ────────────────────────────────────────────────

function buildUserMessage(
  indexContent: string,
  pages: Array<{ wikiPath: string; markdown: string }>,
): string {
  const indexBlock = `<wiki_index>\n${indexContent.trim()}\n</wiki_index>`;
  const pageBlocks = pages
    .map(
      (p) =>
        `<wiki_page slug="${p.wikiPath}">\n${p.markdown.trim()}\n</wiki_page>`,
    )
    .join('\n\n');
  return [
    `Total wiki pages: ${pages.length}`,
    '',
    indexBlock,
    '',
    pageBlocks,
  ].join('\n');
}

// ─── parsing ────────────────────────────────────────────────────────

const VALID_KINDS = new Set<LucidFindingKind>([
  'contradiction',
  'stale_claim',
  'dead_ref',
  'outdated',
  'wanted_page',
  'inconsistent_xref',
]);

function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const fenceEnd = text.lastIndexOf('```');
    if (fenceEnd > 0) {
      text = text.slice(text.indexOf('\n') + 1, fenceEnd).trim();
    }
  }
  return text;
}

function parseLucidFindings(raw: string, runId: string): LucidFinding[] {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn({
      msg: 'dream.lucid.parse_failed',
      runId,
      err: (err as Error).message,
      sample: text.slice(0, 300),
    });
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const list = Array.isArray(obj.findings) ? obj.findings : [];
  const out: LucidFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const kind = f.kind;
    if (typeof kind !== 'string' || !VALID_KINDS.has(kind as LucidFindingKind)) continue;
    const reason = typeof f.reason === 'string' ? f.reason : '';
    if (!reason) continue;
    const affectedPages = Array.isArray(f.affected_pages)
      ? f.affected_pages.filter((p): p is string => typeof p === 'string')
      : [];
    const fix = parseFix(f.fix);
    if (!fix) continue;
    out.push({
      id: out.length + 1,
      kind: kind as LucidFindingKind,
      status: 'pending',
      affected_pages: affectedPages,
      reason,
      fix,
    });
  }
  return out;
}

function parseFix(raw: unknown): LucidFix | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  switch (f.kind) {
    case 'update_page': {
      const wikiPath = typeof f.wikiPath === 'string' ? f.wikiPath : '';
      const newBody = typeof f.newBody === 'string' ? f.newBody : '';
      const logSummary = typeof f.logSummary === 'string' ? f.logSummary : '';
      if (!wikiPath || !newBody || !logSummary) return null;
      return { kind: 'update_page', wikiPath, newBody, logSummary };
    }
    case 'create_page': {
      const subfolder = typeof f.subfolder === 'string' ? f.subfolder : '';
      const wikiPath = typeof f.wikiPath === 'string' ? f.wikiPath : '';
      const type = typeof f.type === 'string' ? f.type : '';
      const title = typeof f.title === 'string' ? f.title : '';
      const body = typeof f.body === 'string' ? f.body : '';
      const logSummary = typeof f.logSummary === 'string' ? f.logSummary : '';
      if (!subfolder || !wikiPath || !type || !title || !body || !logSummary) return null;
      const related = Array.isArray(f.related)
        ? f.related.filter((r): r is string => typeof r === 'string')
        : undefined;
      return {
        kind: 'create_page',
        subfolder,
        wikiPath,
        type,
        title,
        body,
        logSummary,
        ...(related && related.length > 0 ? { related } : {}),
      };
    }
    case 'delete_page': {
      const wikiPath = typeof f.wikiPath === 'string' ? f.wikiPath : '';
      const logSummary = typeof f.logSummary === 'string' ? f.logSummary : '';
      if (!wikiPath || !logSummary) return null;
      return { kind: 'delete_page', wikiPath, logSummary };
    }
    case 'no_op': {
      const note = typeof f.note === 'string' ? f.note : '';
      if (!note) return null;
      return { kind: 'no_op', note };
    }
    default:
      return null;
  }
}

function countByKind(findings: LucidFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    out[f.kind] = (out[f.kind] ?? 0) + 1;
  }
  return out;
}

function makeRunId(trigger: 'auto' | 'manual'): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}-${hh}${mm}${ss}_${trigger}_lucid`;
}

// Resolve un-typed param `_workerModel` for future use (dispatcher-like
// hook). Currently inline in this module.
void (null as unknown as ResolvedModel);
