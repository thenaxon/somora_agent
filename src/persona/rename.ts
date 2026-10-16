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
import { commit, openYaml, render, validateConfigText } from '../setup/config-edit.ts';
import { configPath } from '../config/loader.ts';
import type { Config } from '../config/types.ts';
import { getExternalAgent, listExternalAgents, nativeAgentExists } from '../external/registry.ts';
import { closeAgentConnections } from '../external/connection.ts';
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

/** Rename a map key in place, keeping its comments and position. */
function renameKey(doc: Document, path: string[], from: string, to: string): boolean {
  const map = path.length === 0 ? doc.contents : doc.getIn(path, true);
  if (!isMap(map)) return false;
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === from) {
      pair.key.value = to;
      return true;
    }
  }
  return false;
}

/** Replace a value in a string list, in place. */
function renameInSeq(doc: Document, path: string[], from: string, to: string): boolean {
  const seq = doc.getIn(path, true);
  if (!isSeq(seq)) return false;
  let hit = false;
  for (const item of seq.items) {
    if (isScalar(item) && item.value === from) {
      item.value = to;
      hit = true;
    }
  }
  return hit;
}

function mapKeys(doc: Document, path: string[]): string[] {
  const map = doc.getIn(path, true);
  if (!isMap(map)) return [];
  return map.items.map((p) => (isScalar(p.key) ? String(p.key.value) : '')).filter(Boolean);
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
    const lines = readFileSync(team, 'utf8').split('\n');
    const hits = lines.map((l, i) => (word.test(l) ? i + 1 : 0)).filter(Boolean);
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
  const cfg = openYaml(configPath());
  const cfgChanges: string[] = [];
  if (external) {
    if (renameKey(cfg.doc, ['external', 'systems', external.system, 'agents'], from, to)) cfgChanges.push(`config.yaml: external.systems.${external.system}.agents.${from} → ${to}`);
  }
  const a2aDefault = cfg.doc.getIn(['a2a', 'defaultAgent']);
  if (a2aDefault === from) {
    cfg.doc.setIn(['a2a', 'defaultAgent'], to);
    cfgChanges.push(`config.yaml: a2a.defaultAgent → ${to}`);
  }
  for (const peer of mapKeys(cfg.doc, ['a2a', 'peers'])) {
    if (renameInSeq(cfg.doc, ['a2a', 'peers', peer, 'agents'], from, to)) cfgChanges.push(`config.yaml: a2a.peers.${peer}.agents`);
  }
  for (const p of mapKeys(cfg.doc, ['browser', 'profiles'])) {
    if (renameInSeq(cfg.doc, ['browser', 'profiles', p, 'agents'], from, to)) cfgChanges.push(`config.yaml: browser.profiles.${p}.agents`);
  }
  if (renameKey(cfg.doc, ['tts', 'agentVoices'], from, to)) cfgChanges.push(`config.yaml: tts.agentVoices.${from} → ${to}`);

  const teamPath = teamFilePath();
  const team = existsSync(teamPath) ? openYaml(teamPath) : null;
  const teamChanges: string[] = [];
  if (team) {
    if (renameKey(team.doc, ['agents'], from, to)) teamChanges.push(`team.yaml: agents.${from} → ${to}`);
    for (const a of mapKeys(team.doc, ['agents'])) {
      if (team.doc.getIn(['agents', a, 'reports_to']) === from) {
        team.doc.setIn(['agents', a, 'reports_to'], to);
        teamChanges.push(`team.yaml: ${a} reports to ${to}`);
      }
    }
  }

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
    if (cfgChanges.length > 0) commitCheck(cfg, 'config');
    if (team && teamChanges.length > 0) commitCheck(team, 'plain');
  } catch (err) {
    return fail((err as Error).message);
  }

  // ── let go of what the running server holds ───────────────────────
  if (external) closeAgentConnections(from, to);
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
    if (team && teamChanges.length > 0) {
      commit(team, 'plain');
      done.push(...teamChanges);
    }
    if (cfgChanges.length > 0) {
      commit(cfg, 'config');
      done.push(...cfgChanges);
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
  if (cfgChanges.length > 0) await deps.reloadConfig?.().catch(() => {});
  await deps.syncDreamers?.().catch(() => {});
  report.ok = true;
  report.changes = done;
  report.warnings.push(...(await textMentions(from, to)));
  logger.info({ msg: 'agent.renamed', from, to, kind, changes: done.length });
  return report;
}

/** Throws when the edited document would not load, without writing. */
function commitCheck(file: ReturnType<typeof openYaml>, kind: 'config' | 'plain'): void {
  const text = render(file);
  if (kind === 'config') {
    const problem = validateConfigText(text);
    if (problem) throw new Error(`config.yaml would not load after the rename: ${problem}`);
  } else {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new Error(`team.yaml would not be valid YAML after the rename: ${doc.errors[0]!.message}`);
  }
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
