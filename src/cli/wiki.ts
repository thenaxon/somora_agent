// `somora wiki migrate …` — moving a grown wiki onto the folder template,
// from the shell, against the running server (docs/wiki.md, "Migrating
// a grown wiki"). The command itself never touches the wiki: every step
// is one of the server's /wiki/migration routes, and the server takes
// the backup before it moves a file. Without a subcommand the command
// walks a person through all four steps; the subcommands take flags so
// a script — or an agent that read the docs — can drive them without a
// keyboard. The real run needs the words "move my wiki", from a human.

import { cp, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const CONFIRM = 'move my wiki';

export function usage(): string {
  return [
    'usage: somora wiki migrate [<step> [<plan-id>]] [options]',
    '',
    '  (no step)            guided: plan → judge → approve → dry run → run',
    '  plan                 read the wiki, write what a migration would do (touches nothing)',
    '  judge <id>           the model judges every page; groups the answers for approval',
    '  status <id>          the plan, the groups and what is approved',
    '  approve <id> …       --action move|fold|unclear  --twins  --group <key>  [--dismiss]',
    '  dry-run <id>         walk the approved steps, write dry-run.md, touch nothing',
    '  run <id> --confirm "move my wiki"   full copy of the wiki first, then the approved steps',
    '  undo <id> [--yes]    put the backup of that plan back over the wiki',
    '  relink <id>          second pass: point links and related: at the moved pages (for runs before .07)',
    '',
    'options: --url <server>   (default: from config — https://<publicHost>:<port> or http://127.0.0.1:<port>)',
    '',
  ].join('\n');
}

// ── the server ───────────────────────────────────────────────────────

export interface Api {
  get(path: string): Promise<Record<string, unknown>>;
  post(path: string, body?: unknown): Promise<Record<string, unknown>>;
}

export async function resolveServerUrl(explicit?: string): Promise<string> {
  if (explicit) return explicit.replace(/\/+$/, '');
  if (process.env.SOMORA_URL) return process.env.SOMORA_URL.replace(/\/+$/, '');
  const { loadConfig } = await import('../config/loader.ts');
  const config = await loadConfig();
  const port = process.env.SOMORA_PORT ?? config.server.port;
  const tls = config.server.tls;
  return tls ? `https://${tls.publicHost}:${port}` : `http://127.0.0.1:${port}`;
}

export function httpApi(base: string): Api {
  const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      throw new Error(`cannot reach ${base}: ${(err as Error).message} — is the server running? (somora server status)`);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `${method} ${path} → ${res.status}`);
    return json;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) };
}

// ── printing ─────────────────────────────────────────────────────────

type Out = (line: string) => void;

interface Group {
  action: string;
  target: string | null;
  pages: number;
}

const groupKey = (g: Group): string => `${g.action}:${g.target ?? ''}`;

function describeGroup(g: Group): string {
  switch (g.action) {
    case 'move':
      return `move ${g.pages} page${g.pages === 1 ? '' : 's'} to ${g.target}/`;
    case 'fold':
      return `fold ${g.pages} page${g.pages === 1 ? '' : 's'} into ${g.target}`;
    case 'keep':
      return `keep ${g.pages} page${g.pages === 1 ? '' : 's'} where they are`;
    default:
      return `${g.pages} page${g.pages === 1 ? '' : 's'} unclear`;
  }
}

function summaryLine(sum: Record<string, { items: number; pages: number }>): string {
  return `rule moves ${sum.move_folder?.pages ?? 0} · same-name pages ${sum.unite_twins?.pages ?? 0} · dated reports ${sum.fold_report?.pages ?? 0} · pages for the model ${sum.review_pages?.pages ?? 0} · unclear ${sum.unclear?.pages ?? 0}`;
}

// ── steps ────────────────────────────────────────────────────────────

export async function stepPlan(api: Api, out: Out): Promise<string> {
  const r = await api.post('/wiki/migration/plan');
  out(`Plan ${r.id}: ${r.pagesTotal} pages in ${r.foldersTotal} folders — ${summaryLine(r.summary as never)}`);
  out(`  written to ${r.plan}`);
  return String(r.id);
}

export async function stepJudge(api: Api, id: string, out: Out, pollMs = 10_000): Promise<Group[]> {
  const st = await api.get(`/wiki/migration/plans/${id}`);
  if (!st.refined) {
    const r = await api.post('/wiki/migration/refine', { id });
    out(`Judging every page with the model (${r.message ?? 'started'}) …`);
    let last = '';
    for (;;) {
      await new Promise((res) => setTimeout(res, pollMs));
      const s = await api.get(`/wiki/migration/plans/${id}`);
      const p = s.refine as { done: number; total: number; finished?: string; error?: string } | null;
      if (p?.error) throw new Error(`judging failed: ${p.error}`);
      const line = p ? `  ${p.done} of ${p.total} batches` : '  …';
      if (line !== last) {
        out(line);
        last = line;
      }
      if (p?.finished || s.refined) break;
    }
  }
  const s = await api.get(`/wiki/migration/plans/${id}`);
  const refined = s.refined as { model: string; pagesJudged: number; batchesFailed: number; groups: Group[] } | null;
  if (!refined) throw new Error('no judged result — run `somora wiki migrate judge <id>` again');
  out(`Judged ${refined.pagesJudged} pages with ${refined.model}${refined.batchesFailed ? ` — ${refined.batchesFailed} batches FAILED, their pages are "unclear"` : ''}`);
  out(`  details in ${SOMORA_HOME}/wiki-migration/${id}/refined.md`);
  return refined.groups;
}

export async function stepStatus(api: Api, id: string, out: Out): Promise<{ groups: Group[]; approvals: Record<string, { status: string }>; twins: Record<string, { status: string }> }> {
  const s = await api.get(`/wiki/migration/plans/${id}`);
  const plan = s.plan as { pagesTotal: number; foldersTotal: number; summary: Record<string, { items: number; pages: number }> };
  const refined = s.refined as { groups: Group[]; pagesJudged: number } | null;
  const approvals = (s.approvals as { groups: Record<string, { status: string }>; twins: Record<string, { status: string }> }) ?? { groups: {}, twins: {} };
  out(`Plan ${id}: ${plan.pagesTotal} pages in ${plan.foldersTotal} folders — ${summaryLine(plan.summary)}`);
  if (!refined) {
    out('  not judged yet — `somora wiki migrate judge ' + id + '`');
    return { groups: [], approvals: approvals.groups, twins: approvals.twins };
  }
  out(`  ${refined.groups.length} groups from ${refined.pagesJudged} judged pages:`);
  for (const g of refined.groups) {
    if (g.action === 'keep') continue;
    const st = approvals.groups[groupKey(g)]?.status ?? 'pending';
    out(`  [${st === 'approved' ? 'x' : st === 'dismissed' ? '-' : ' '}] ${describeGroup(g)}`);
  }
  const keep = refined.groups.filter((g) => g.action === 'keep').reduce((n, g) => n + g.pages, 0);
  if (keep > 0) out(`      ${keep} pages stay where they are`);
  const twins = Object.values(approvals.twins).filter((t) => t.status === 'approved').length;
  out(`  same-name unions approved: ${twins}`);
  const ex = s.execute as { done: number; total: number; dryRun: boolean; finished?: string; error?: string } | null;
  if (ex) out(`  last ${ex.dryRun ? 'dry run' : 'run'}: ${ex.done}/${ex.total}${ex.finished ? ' finished ' + ex.finished : ' running'}${ex.error ? ' ERROR ' + ex.error : ''}`);
  return { groups: refined.groups, approvals: approvals.groups, twins: approvals.twins };
}

export async function stepApprove(api: Api, id: string, sel: { actions: string[]; groups: string[]; twins: boolean; dismiss: boolean }, out: Out): Promise<void> {
  const status = sel.dismiss ? 'dismissed' : 'approved';
  let last: Record<string, unknown> = {};
  for (const action of sel.actions) last = await api.post(`/wiki/migration/plans/${id}/approve`, { action, status });
  if (sel.groups.length > 0) last = await api.post(`/wiki/migration/plans/${id}/approve`, { groups: sel.groups, status });
  if (sel.twins) last = await api.post(`/wiki/migration/plans/${id}/approve`, { twins: 'all', status });
  if (sel.actions.length === 0 && sel.groups.length === 0 && !sel.twins) throw new Error('nothing selected — use --action, --group or --twins');
  out(`${status}: now ${last.approvedGroups} groups (${last.approvedPages} pages) and ${last.approvedTwins} same-name unions approved`);
}

export async function stepDryRun(api: Api, id: string, out: Out): Promise<Record<string, unknown>> {
  const r = await api.post(`/wiki/migration/plans/${id}/execute`, { dryRun: true, wait: true });
  const c = (r.counts ?? {}) as Record<string, number | undefined>;
  const steps = ['move', 'fold', 'unite', 'failed', 'skipped'].reduce((n, k) => n + (c[k] ?? 0), 0);
  out(`Dry run: ${steps} steps planned, ${r.linksRewritten} links would change — nothing written`);
  out(`  report: ${r.report}`);
  return r;
}

export async function stepRun(api: Api, id: string, confirm: string, out: Out, pollMs = 10_000): Promise<Record<string, unknown>> {
  if (confirm !== CONFIRM) throw new Error(`a real run needs --confirm "${CONFIRM}"`);
  const r = await api.post(`/wiki/migration/plans/${id}/execute`, { dryRun: false, confirm });
  out(`Running — the server copies the whole wiki first, then moves. ${r.message ?? ''}`);
  let last = '';
  for (;;) {
    await new Promise((res) => setTimeout(res, pollMs));
    const s = await api.get(`/wiki/migration/plans/${id}`);
    const ex = s.execute as { done: number; total: number; finished?: string; error?: string; last?: string } | null;
    if (ex?.error) throw new Error(`run failed: ${ex.error}`);
    const line = ex ? `  ${ex.done} of ${ex.total}${ex.last ? ' — ' + ex.last : ''}` : '  …';
    if (line !== last) {
      out(line);
      last = line;
    }
    if (ex?.finished) break;
  }
  const files = await readdir(join(SOMORA_HOME, 'wiki-migration', id)).catch(() => [] as string[]);
  const report = files.filter((f) => /^execution-.*\.md$/.test(f)).sort().pop();
  out(`Done. Report: ${report ? join(SOMORA_HOME, 'wiki-migration', id, report) : '(see the plan folder)'}`);
  const backup = files.filter((f) => f.startsWith('backup-')).sort().pop();
  if (backup) out(`Backup: ${join(SOMORA_HOME, 'wiki-migration', id, backup)} — \`somora wiki migrate undo ${id}\` puts it back`);
  return { report, backup };
}

/**
 * Put the newest backup of a plan back: the current wiki folder is
 * moved aside (never deleted), the backup copied to the wiki's place,
 * and the server asked to sweep the search index.
 */
export async function stepUndo(args: { id: string; wikiAbs: string; api?: Api; yes: boolean; ask?: (q: string) => Promise<string>; out: Out; now?: Date }): Promise<{ restoredFrom: string; movedAsideTo: string }> {
  const dir = join(SOMORA_HOME, 'wiki-migration', args.id);
  const backups = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith('backup-')).sort();
  const backup = backups.pop();
  if (!backup) throw new Error(`no backup under ${dir}`);
  const from = join(dir, backup);
  const stamp = (args.now ?? new Date()).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const aside = `${args.wikiAbs.replace(/\/+$/, '')}.before-undo-${stamp}`;
  args.out(`Restore ${from}\n  over ${args.wikiAbs}\n  (the current wiki is moved to ${aside}, nothing is deleted)`);
  if (!args.yes) {
    const a = (await (args.ask ?? defaultAsk)('Type "yes" to restore: ')).trim().toLowerCase();
    if (a !== 'yes') throw new Error('cancelled');
  }
  await rename(args.wikiAbs, aside);
  await mkdir(args.wikiAbs, { recursive: true });
  await cp(from, args.wikiAbs, { recursive: true });
  const [a, b] = await Promise.all([countFiles(from), countFiles(args.wikiAbs)]);
  if (a !== b) throw new Error(`restore incomplete: ${b} of ${a} files — the previous state is still at ${aside}`);
  args.out(`Restored ${b} files.`);
  if (args.api) {
    try {
      const r = await args.api.post('/wiki/migration/reindex');
      args.out(`Search index swept: ${r.indexed} indexed, ${r.skipped} unchanged.`);
    } catch (err) {
      args.out(`Search index not swept (${(err as Error).message}) — the 10-minute rescan will catch up.`);
    }
  }
  return { restoredFrom: from, movedAsideTo: aside };
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else n++;
  }
  return n;
}

async function defaultAsk(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

// ── guided mode ──────────────────────────────────────────────────────

export async function guided(api: Api, out: Out, ask: (q: string) => Promise<string> = defaultAsk, pollMs = 10_000): Promise<number> {
  out('Step 1 of 4 — the plan');
  const id = await stepPlan(api, out);
  out('');
  out('Step 2 of 4 — the model judges every page');
  const groups = await stepJudge(api, id, out, pollMs);
  out('');
  out('Step 3 of 4 — approve');
  const acting = groups.filter((g) => g.action === 'move' || g.action === 'fold');
  acting.forEach((g, i) => out(`  ${String(i + 1).padStart(3)}  ${describeGroup(g)}`));
  const unclear = groups.filter((g) => g.action === 'unclear').reduce((n, g) => n + g.pages, 0);
  if (unclear > 0) out(`       (${unclear} unclear pages stay where they are — see refined.md)`);
  const answer = (await ask('Numbers to leave OUT (space-separated), "none" to approve everything, or "q" to stop here: ')).trim().toLowerCase();
  if (answer === 'q') {
    out(`Stopped. Continue later with: somora wiki migrate status ${id}`);
    return 0;
  }
  const leaveOut = new Set(answer === '' || answer === 'none' ? [] : answer.split(/[\s,]+/).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= acting.length));
  const approvedKeys = acting.filter((_, i) => !leaveOut.has(i + 1)).map(groupKey);
  const dismissedKeys = acting.filter((_, i) => leaveOut.has(i + 1)).map(groupKey);
  if (approvedKeys.length > 0) await stepApprove(api, id, { actions: [], groups: approvedKeys, twins: true, dismiss: false }, out);
  if (dismissedKeys.length > 0) await stepApprove(api, id, { actions: [], groups: dismissedKeys, twins: false, dismiss: true }, out);
  out('');
  out('Step 4 of 4 — dry run, then the real run');
  await stepDryRun(api, id, out);
  const word = (await ask(`Type "${CONFIRM}" to run for real (a full copy of the wiki is taken first), anything else to stop: `)).trim();
  if (word !== CONFIRM) {
    out(`Stopped before any change. Run later with: somora wiki migrate run ${id} --confirm "${CONFIRM}"`);
    return 0;
  }
  await stepRun(api, id, word, out, pollMs);
  return 0;
}

// ── argv ─────────────────────────────────────────────────────────────

export interface Parsed {
  step: string;
  id?: string;
  url?: string;
  actions: string[];
  groups: string[];
  twins: boolean;
  dismiss: boolean;
  confirm?: string;
  yes: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { step: '', actions: [], groups: [], twins: false, dismiss: false, yes: false, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') p.help = true;
    else if (a === '--url') p.url = next();
    else if (a === '--action') p.actions.push(next());
    else if (a === '--group') p.groups.push(next());
    else if (a === '--twins') p.twins = true;
    else if (a === '--dismiss') p.dismiss = true;
    else if (a === '--confirm') p.confirm = next();
    else if (a === '--yes' || a === '-y') p.yes = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  p.step = rest[0] ?? '';
  if (rest[1]) p.id = rest[1];
  return p;
}

export async function runWikiCli(argv: string[], deps: { api?: Api; out?: Out; ask?: (q: string) => Promise<string>; pollMs?: number } = {}): Promise<number> {
  const out: Out = deps.out ?? ((l) => process.stdout.write(`${l}\n`));
  if (argv[0] !== 'migrate') {
    process.stderr.write(usage());
    return argv[0] === '--help' || argv[0] === '-h' ? 0 : 2;
  }
  let p: Parsed;
  try {
    p = parseArgs(argv.slice(1));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${usage()}`);
    return 2;
  }
  if (p.help) {
    out(usage());
    return 0;
  }
  try {
    const api = deps.api ?? httpApi(await resolveServerUrl(p.url));
    const needId = (): string => {
      if (!p.id) throw new Error(`${p.step} needs a plan id (from \`somora wiki migrate plan\`)`);
      return p.id;
    };
    switch (p.step) {
      case '':
        return await guided(api, out, deps.ask, deps.pollMs);
      case 'plan':
        await stepPlan(api, out);
        return 0;
      case 'judge':
        await stepJudge(api, needId(), out, deps.pollMs);
        return 0;
      case 'status':
        await stepStatus(api, needId(), out);
        return 0;
      case 'approve':
        await stepApprove(api, needId(), { actions: p.actions, groups: p.groups, twins: p.twins, dismiss: p.dismiss }, out);
        return 0;
      case 'dry-run':
        await stepDryRun(api, needId(), out);
        return 0;
      case 'run':
        await stepRun(api, needId(), p.confirm ?? '', out, deps.pollMs);
        return 0;
      case 'relink': {
        const r = await api.post(`/wiki/migration/plans/${needId()}/relink`, {});
        out(`Relinked: ${r.refsRewritten} references in ${r.pagesTouched} pages (${r.renames} renames from the run)`);
        return 0;
      }
      case 'undo': {
        const id = needId();
        const st = await api.get('/wiki/status').catch(() => ({} as Record<string, unknown>));
        const wikiAbs = typeof st.wikiAbs === 'string' ? st.wikiAbs : typeof st.root === 'string' ? st.root : '';
        if (!wikiAbs) throw new Error('the server did not tell where the wiki is (GET /wiki/status) — is the wiki enabled?');
        await stepUndo({ id, wikiAbs, api, yes: p.yes, ...(deps.ask ? { ask: deps.ask } : {}), out });
        return 0;
      }
      default:
        process.stderr.write(`unknown step: ${p.step}\n${usage()}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}
