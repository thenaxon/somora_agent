// Renaming an agent (docs/agents.md#renaming-an-agent): one step that
// carries every place the name lives — a somora agent's folder (sessions,
// memory, notes, tools' files) and the name in its AGENTS.md, the paths in
// its memory index, its dream files, its browser profile, Sentinel
// triggers, tmux records, team.yaml, and the config.yaml fields that name
// it (an external agent's own entry, A2A, browser profiles, voices).
//
// It runs only while nothing is running for the agent. Texts are left
// alone — personas, notes, team rules — and reported where they still
// say the old name: they are the person's or the agents' own words.

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { validateConfigText } from '../setup/config-edit.ts';
import { configPath } from '../config/loader.ts';
import type { Config } from '../config/types.ts';
import { getExternalAgent, listExternalAgents, nativeAgentExists } from '../external/registry.ts';
import { closeAgentConnections } from '../external/connection.ts';
import { flushUnprompted } from '../external/unprompted.ts';
import { evictMemoryManager } from '../memory/registry.ts';
import { listAgents, loadPersona } from '../persona/loader.ts';
import { listAllSessionLockStates } from '../server/session-queue.ts';
import { listWork } from '../server/work-ledger.ts';
import { listTriggers, loadTriggers, saveTrigger } from '../sentinel/store.ts';
import { resetTeamCache, teamFilePath } from '../team/store.ts';
import { logger } from '../server/logger.ts';

/** The strictest of the places a name goes (team.yaml, browser
 *  profiles): lower-case letters, digits, `-` and `_`. */
export const AGENT_NAME_RULE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface RenameDeps {
  config: Config;
  /** Take the old name out of the REM worker. */
  remUnregister?: (agent: string) => void;
  /** Register dreamers again (the new name). */
  syncDreamers?: () => Promise<void>;
  /** Reload config.yaml in the running server. */
  reloadConfig?: () => Promise<void>;
}

export interface RenameReport {
  ok: boolean;
  from: string;
  to: string;
  kind: 'somora' | 'external';
  dryRun: boolean;
  /** What was (or would be) changed, one line each. */
  changes: string[];
  /** Places that still say the old name, and things to tell others. */
  warnings: string[];
  error?: string;
}

const home = () => process.env.SOMORA_HOME ?? join(homedir(), '.somora');

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-rename`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Why the agent cannot be renamed right now, or null. */
function busyReason(name: string): string | null {
  const locks = listAllSessionLockStates().filter((l) => l.agent === name && (l.busy || l.queueLength > 0));
  if (locks.length > 0) return `a turn is running or waiting in ${locks.map((l) => l.session).join(', ')}`;
  const work = listWork().filter((w) => (w.state === 'running' || w.state === 'queued') && (w.target.agent === name || (w.requester !== undefined && 'agent' in w.requester && w.requester.agent === name)));
  if (work.length > 0) return `${work.length} piece${work.length === 1 ? '' : 's'} of work for or from it are still open (agent_ask, sub-agents, wakes)`;
  const jobs = join(home(), 'agents', name, 'exec-jobs');
  if (existsSync(jobs)) {
    for (const d of readdirSync(jobs)) {
      const m = readJson<{ state?: string }>(join(jobs, d, 'meta.json'));
      if (m?.state === 'running') return `a background command (exec job ${d}) is still running`;
    }
  }
  const profile = join(home(), 'browser', 'profiles', name);
  if (existsSync(join(profile, 'SingletonLock'))) return 'its browser is running — close it first';
  const loop = readJson<{ agent?: string; active?: boolean }>(join(home(), 'wiki-lucid', 'loop-state.json'));
  if (loop?.agent === name && loop.active !== false) return 'it holds the Lucid review loop';
  return null;
}

// ── surgical YAML edits ─────────────────────────────────────────────
// A rename changes a name and nothing else: the edits replace exactly the
// characters of each occurrence in the file's text, found through the
// parsed document's source ranges. Re-rendering the document would
// rewrap long texts and re-indent a hand-kept file.

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** The replacement for a scalar node, in the same quoting style. */
function scalarEdit(node: unknown, to: string): Edit | null {
  if (!isScalar(node) || !node.range) return null;
  const quote = node.type === 'QUOTE_SINGLE' ? "'" : node.type === 'QUOTE_DOUBLE' ? '"' : '';
  return { start: node.range[0], end: node.range[1], text: `${quote}${to}${quote}` };
}

/** Edit for a map key `from` at `path`. */
function keyEdit(doc: Document, path: string[], from: string, to: string): Edit | null {
  const map = path.length === 0 ? doc.contents : doc.getIn(path, true);
  if (!isMap(map)) return null;
  for (const pair of map.items) if (isScalar(pair.key) && pair.key.value === from) return scalarEdit(pair.key, to);
  return null;
}

/** Edits for every `from` in a string list at `path`. */
function seqEdits(doc: Document, path: string[], from: string, to: string): Edit[] {
  const seq = doc.getIn(path, true);
  if (!isSeq(seq)) return [];
  return seq.items.filter((it) => isScalar(it) && it.value === from).map((it) => scalarEdit(it, to)).filter((e): e is Edit => e !== null);
}

/** Edit for a scalar value `from` at `path`. */
function valueEdit(doc: Document, path: string[], from: string, to: string): Edit | null {
  const node = doc.getIn(path, true);
  return isScalar(node) && node.value === from ? scalarEdit(node, to) : null;
}

function mapKeys(doc: Document, path: string[]): string[] {
  const map = doc.getIn(path, true);
  if (!isMap(map)) return [];
  return map.items.map((p) => (isScalar(p.key) ? String(p.key.value) : '')).filter(Boolean);
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

interface YamlEdit {
  path: string;
  original: string;
  next: string;
  changes: string[];
}

function readYamlFile(path: string): { text: string; doc: Document } | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0]!.message}`);
  return { text, doc };
}

/** Write with a backup beside it, atomically. */
function writeWithBackup(file: YamlEdit): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backup = `${file.path}.bak-rename-${stamp}`;
  writeFileSync(backup, file.original, { mode: 0o600 });
  const tmp = `${file.path}.tmp-rename`;
  writeFileSync(tmp, file.next, { mode: 0o600 });
  renameSync(tmp, file.path);
  return backup;
}

/** Where texts still say the old name: personas of every agent, team rules. */
async function textMentions(from: string, to: string): Promise<string[]> {
  const out: string[] = [];
  const word = new RegExp(`(^|[^A-Za-z0-9_-])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`, 'i');
  for (const a of await listAgents()) {
    for (const f of ['AGENTS.md', 'SOUL.md', 'USER.md']) {
      const p = join(home(), 'agents', a.name, f);
      if (!existsSync(p)) continue;
      const lines = readFileSync(p, 'utf8').split('\n');
      const hits = lines.map((l, i) => (word.test(l) && !(a.name === to && f === 'AGENTS.md' && /^name:/.test(l)) ? i + 1 : 0)).filter(Boolean);
      if (hits.length > 0) out.push(`${a.name}/${f} still says '${from}' (line ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''})`);
    }
  }
  const team = teamFilePath();
  if (existsSync(team)) {
    // The entry and reports_to lines are the rename's own business.
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const structural = new RegExp(`^\\s*(${esc}:|reports_to:\\s*['"]?${esc}['"]?)\\s*(#.*)?$`);
    const lines = readFileSync(team, 'utf8').split('\n');
    const hits = lines.map((l, i) => (word.test(l) && !structural.test(l) ? i + 1 : 0)).filter(Boolean);
    if (hits.length > 0) out.push(`team.yaml still says '${from}' in its text (line ${hits.slice(0, 5).join(', ')}) — a rule or note, left as written`);
  }
  return out;
}

export async function renameAgent(from: string, to: string, deps: RenameDeps, opts: { dryRun?: boolean } = {}): Promise<RenameReport> {
  const dryRun = opts.dryRun === true;
  const external = getExternalAgent(from, deps.config);
  const persona = external ? null : await loadPersona(from);
  const kind: RenameReport['kind'] = external ? 'external' : 'somora';
  const report: RenameReport = { ok: false, from, to, kind, dryRun, changes: [], warnings: [] };
  const fail = (error: string): RenameReport => ({ ...report, error });

  // ── checks ─────────────────────────────────────────────────────────
  if (!external && !persona) return fail(`no agent '${from}'`);
  if (from === to) return fail('the new name is the old one');
  if (!AGENT_NAME_RULE.test(to)) return fail(`'${to}' is not a valid agent name: lower-case letters, digits, - and _, starting with a letter or digit, at most 64 characters`);
  if (nativeAgentExists(to) || getExternalAgent(to, deps.config) || existsSync(join(home(), 'agents', to))) return fail(`an agent or folder named '${to}' already exists`);
  const busy = busyReason(from);
  if (busy) return fail(`'${from}' is busy: ${busy}. Try again when it is idle.`);

  const dir = join(home(), 'agents', from);
  const newDir = join(home(), 'agents', to);
  const hasDir = existsSync(dir);

  // ── prepare the YAML edits (validated before anything moves) ──────
  const cfgFile = readYamlFile(configPath());
  const cfgEdits: Edit[] = [];
  const cfgChanges: string[] = [];
  if (cfgFile) {
    const d = cfgFile.doc;
    const push = (e: Edit | Edit[] | null, change: string) => {
      const list = Array.isArray(e) ? e : e ? [e] : [];
      if (list.length > 0) {
        cfgEdits.push(...list);
        cfgChanges.push(change);
      }
    };
    if (external) push(keyEdit(d, ['external', 'systems', external.system, 'agents'], from, to), `config.yaml: external.systems.${external.system}.agents.${from} → ${to}`);
    push(valueEdit(d, ['a2a', 'defaultAgent'], from, to), `config.yaml: a2a.defaultAgent → ${to}`);
    for (const peer of mapKeys(d, ['a2a', 'peers'])) push(seqEdits(d, ['a2a', 'peers', peer, 'agents'], from, to), `config.yaml: a2a.peers.${peer}.agents`);
    for (const p of mapKeys(d, ['browser', 'profiles'])) push(seqEdits(d, ['browser', 'profiles', p, 'agents'], from, to), `config.yaml: browser.profiles.${p}.agents`);
    push(keyEdit(d, ['tts', 'agentVoices'], from, to), `config.yaml: tts.agentVoices.${from} → ${to}`);
  }
  const cfg: YamlEdit | null = cfgFile && cfgEdits.length > 0 ? { path: configPath(), original: cfgFile.text, next: applyEdits(cfgFile.text, cfgEdits), changes: cfgChanges } : null;

  const teamPath = teamFilePath();
  const teamFile = readYamlFile(teamPath);
  const teamEdits: Edit[] = [];
  const teamChanges: string[] = [];
  if (teamFile) {
    const k = keyEdit(teamFile.doc, ['agents'], from, to);
    if (k) {
      teamEdits.push(k);
      teamChanges.push(`team.yaml: agents.${from} → ${to}`);
    }
    for (const a of mapKeys(teamFile.doc, ['agents'])) {
      const e = valueEdit(teamFile.doc, ['agents', a, 'reports_to'], from, to);
      if (e) {
        teamEdits.push(e);
        teamChanges.push(`team.yaml: ${a === from ? to : a} reports to ${to}`);
      }
    }
  }
  const team: YamlEdit | null = teamFile && teamEdits.length > 0 ? { path: teamPath, original: teamFile.text, next: applyEdits(teamFile.text, teamEdits), changes: teamChanges } : null;

  // Another process (an agent's tool child) may have written triggers.
  await loadTriggers().catch(() => {});
  const triggers = listTriggers().filter((t) => t.dispatch?.agent === from || (t as { ownerAgent?: string }).ownerAgent === from);
  const browserProfile = join(home(), 'browser', 'profiles', from);
  const hasBrowser = existsSync(browserProfile);

  // ── the plan ──────────────────────────────────────────────────────
  const plan: string[] = [];
  if (hasDir) plan.push(`folder agents/${from} → agents/${to} (sessions${persona ? ', memory, notes, agent.yaml' : ''})`);
  if (persona) plan.push(`AGENTS.md: name → ${to}`, 'memory index: paths under the new folder', 'dream files: agent → ' + to);
  if (hasBrowser) plan.push(`browser profile browser/profiles/${from} → ${to} (its logins come along)`);
  if (triggers.length > 0) plan.push(`Sentinel: ${triggers.length} trigger${triggers.length === 1 ? '' : 's'} now for ${to}`);
  plan.push(...teamChanges, ...cfgChanges);
  report.changes = plan;
  if (persona?.a2a) report.warnings.push(`other systems reach it at a new address: …/a2a/agents/${to} (tell the peers that call /a2a/agents/${from})`);
  if (persona) report.warnings.push(`editors or scripts that run 'somora acp --agent ${from}' need the new name`);
  if (persona) {
    // Its standing conversations with external agents (a2a-<name>).
    const withExternal = listExternalAgents(deps.config)
      .filter((e) => existsSync(join(home(), 'agents', e.name, 'sessions')) && readdirSync(join(home(), 'agents', e.name, 'sessions')).some((f) => f.endsWith(`_a2a-${from}.jsonl`)))
      .map((e) => e.name);
    if (withExternal.length > 0) report.warnings.push(`its conversations with ${withExternal.join(', ')} start afresh as a2a-${to}; the old ones stay as a2a-${from}`);
  }

  if (dryRun) {
    report.ok = true;
    report.warnings.push(...(await textMentions(from, to)));
    return report;
  }

  // Validate the YAML before touching the disk: a result that would not
  // load stops here, with nothing moved.
  try {
    if (cfg) {
      const problem = validateConfigText(cfg.next);
      if (problem) throw new Error(`config.yaml would not load after the rename: ${problem}`);
    }
    if (team) {
      const d = parseDocument(team.next);
      if (d.errors.length > 0) throw new Error(`team.yaml would not be valid YAML after the rename: ${d.errors[0]!.message}`);
    }
  } catch (err) {
    return fail((err as Error).message);
  }

  // ── let go of what the running server holds ───────────────────────
  if (external) {
    closeAgentConnections(from, to);
    // What it sent on its own and not yet written goes into its sessions
    // now, before the folder moves (a later write would make agents/<from>
    // again).
    await flushUnprompted(from);
  }
  if (persona) {
    await evictMemoryManager(from);
    deps.remUnregister?.(from);
  }

  // ── move and rewrite ──────────────────────────────────────────────
  const done: string[] = [];
  try {
    if (hasDir) {
      renameSync(dir, newDir);
      done.push(`folder agents/${from} → agents/${to}`);
    }
    if (persona) {
      const md = join(newDir, 'AGENTS.md');
      const text = readFileSync(md, 'utf8');
      const fixed = text.replace(/^(---\r?\n[\s\S]*?)^name:\s*.*$/m, (_m, head: string) => `${head}name: ${to}`);
      if (fixed !== text) {
        writeFileSync(md, fixed);
        done.push(`AGENTS.md: name → ${to}`);
      }
      const n = movedIndexPaths(join(newDir, 'memory.db'), dir, newDir);
      if (n !== null) done.push(`memory index: ${n} path${n === 1 ? '' : 's'} moved`);
      const d = rewriteDreamFiles(join(newDir, 'memory', '.dreams'), from, to);
      if (d > 0) done.push(`dream files: ${d} now name ${to}`);
    }
    if (hasBrowser) {
      renameSync(browserProfile, join(home(), 'browser', 'profiles', to));
      rewriteBrowserState(from, to);
      done.push(`browser profile → ${to}`);
    }
    for (const t of triggers) {
      const next = { ...t, dispatch: { ...t.dispatch, ...(t.dispatch?.agent === from ? { agent: to } : {}) } } as typeof t & { ownerAgent?: string };
      if ((t as { ownerAgent?: string }).ownerAgent === from) next.ownerAgent = to;
      await saveTrigger(next);
    }
    if (triggers.length > 0) done.push(`Sentinel: ${triggers.length} trigger${triggers.length === 1 ? '' : 's'}`);
    const tm = rewriteTmux(from, to);
    if (tm > 0) done.push(`tmux records: ${tm}`);
    if (team) {
      writeWithBackup(team);
      done.push(...team.changes);
    }
    if (cfg) {
      writeWithBackup(cfg);
      done.push(...cfg.changes);
    }
  } catch (err) {
    // Put the folder back when the step after it failed; report the rest.
    if (hasDir && existsSync(newDir) && !existsSync(dir) && !done.some((x) => x.startsWith('team.yaml') || x.startsWith('config.yaml'))) {
      try {
        renameSync(newDir, dir);
        done.length = 0;
        done.push('the folder was moved back');
      } catch {
        /* reported below */
      }
    }
    logger.error({ msg: 'agent.rename_failed', from, to, err: (err as Error).message, done });
    return { ...report, changes: done, error: `rename stopped: ${(err as Error).message}` };
  }

  resetTeamCache();
  if (cfg) await deps.reloadConfig?.().catch(() => {});
  await deps.syncDreamers?.().catch(() => {});
  report.ok = true;
  report.changes = done;
  report.warnings.push(...(await textMentions(from, to)));
  logger.info({ msg: 'agent.renamed', from, to, kind, changes: done.length });
  return report;
}

/** Point the memory index's paths at the new folder. Null when there is
 *  no index. */
function movedIndexPaths(dbPath: string, oldDir: string, newDir: string): number | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = OFF');
    const like = `${oldDir}/%`;
    const tx = db.transaction(() => {
      const files = db.prepare('UPDATE files SET path = ? || substr(path, ?) WHERE path LIKE ?').run(newDir, oldDir.length + 1, like).changes;
      db.prepare('UPDATE chunks SET file_path = ? || substr(file_path, ?) WHERE file_path LIKE ?').run(newDir, oldDir.length + 1, like);
      return files;
    });
    return tx() as number;
  } finally {
    db.close();
  }
}

function rewriteDreamFiles(dir: string, from: string, to: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.json')) {
        const j = readJson<{ agent?: string }>(p);
        if (j && j.agent === from) {
          j.agent = to;
          writeJson(p, j);
          n += 1;
        }
      }
    }
  };
  walk(dir);
  return n;
}

function rewriteBrowserState(from: string, to: string): void {
  const path = join(home(), 'browser', 'state.json');
  const state = readJson<unknown>(path);
  if (!state) return;
  const ids = new Map([
    [`agent:${from}`, `agent:${to}`],
    [`agent:${from}@${from}`, `agent:${to}@${to}`],
  ]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const key = ids.get(k) ?? k;
        out[key] = (k === 'agent' || k === 'profile') && x === from ? to : typeof x === 'string' && ids.has(x) ? ids.get(x) : walk(x);
      }
      return out;
    }
    return v;
  };
  writeJson(path, walk(state));
}

function rewriteTmux(from: string, to: string): number {
  let n = 0;
  for (const f of ['tmux-origins.json', 'tmux-observations.json']) {
    const path = join(home(), f);
    const m = readJson<Record<string, { agent?: string }>>(path);
    if (!m) continue;
    let changed = false;
    for (const rec of Object.values(m)) {
      if (rec && rec.agent === from) {
        rec.agent = to;
        changed = true;
        n += 1;
      }
    }
    if (changed) writeJson(path, m);
  }
  return n;
}
