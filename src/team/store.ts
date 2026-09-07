// team.yaml on disk → ResolvedTeam, cached by file mtime and by the
// agent roster. No restart needed: the next turn after a save sees the
// change. An invalid file keeps the last valid team in force (or the
// feature off when there never was one) and logs once per mtime.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { logger } from '../server/logger.ts';
import { listAgents } from '../persona/loader.ts';
import { parseTeamFile, resolveTeam } from './resolve.ts';
import { renderTeamBlock } from './render.ts';
import { TEAM_FILE_NAME, type ResolvedTeam, type TeamAgentInfo, type TeamFile, type TeamIssue } from './types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

export function teamFilePath(): string {
  return join(SOMORA_HOME, TEAM_FILE_NAME);
}

export interface TeamLoad {
  /** null = no file, or the file is invalid (see issues). */
  file: TeamFile | null;
  exists: boolean;
  issues: TeamIssue[];
  mtimeMs: number | null;
}

/** Read + parse + validate. Never throws. */
export async function loadTeamFile(): Promise<TeamLoad> {
  const path = teamFilePath();
  let raw: string;
  let mtimeMs: number;
  try {
    const st = await stat(path);
    mtimeMs = st.mtimeMs;
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file: null, exists: false, issues: [], mtimeMs: null };
    }
    return { file: null, exists: true, issues: [{ path: '(file)', message: String(err) }], mtimeMs: null };
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return { file: null, exists: true, issues: [{ path: '(yaml)', message: (err as Error).message }], mtimeMs };
  }
  const parsed = parseTeamFile(doc ?? {});
  return { file: parsed.file, exists: true, issues: parsed.issues, mtimeMs };
}

// ── cache ────────────────────────────────────────────────────────────

const ROSTER_TTL_MS = 30_000;

let cached: { mtimeMs: number; rosterKey: string; team: ResolvedTeam } | null = null;
let lastValidTeam: ResolvedTeam | null = null;
let rosterCache: { at: number; agents: TeamAgentInfo[]; key: string } | null = null;
let warnedForMtime: number | null = null;

async function roster(): Promise<{ agents: TeamAgentInfo[]; key: string }> {
  const now = Date.now();
  if (rosterCache && now - rosterCache.at < ROSTER_TTL_MS) return rosterCache;
  const list = await listAgents();
  const agents: TeamAgentInfo[] = list.map((a) => ({ name: a.name, role: a.role, description: a.description }));
  const key = agents.map((a) => `${a.name}:${a.role ?? ''}:${a.description}`).join('|');
  rosterCache = { at: now, agents, key };
  return rosterCache;
}

/** Drop caches — used by tests and after a PUT. */
export function resetTeamCache(): void {
  cached = null;
  rosterCache = null;
  warnedForMtime = null;
}

/**
 * The team in force right now, or null when the feature is off
 * (no file, or an invalid file with no earlier valid load).
 */
export async function getResolvedTeam(): Promise<ResolvedTeam | null> {
  const load = await loadTeamFile();
  if (!load.exists) {
    cached = null;
    lastValidTeam = null;
    return null;
  }
  if (!load.file) {
    if (warnedForMtime !== load.mtimeMs) {
      warnedForMtime = load.mtimeMs;
      logger.warn({
        msg: 'team.invalid',
        path: teamFilePath(),
        issues: load.issues,
        hint: lastValidTeam ? 'keeping the last valid team' : 'team block disabled until the file is fixed',
      });
    }
    return lastValidTeam;
  }
  const r = await roster();
  if (cached && cached.mtimeMs === load.mtimeMs && cached.rosterKey === r.key) return cached.team;
  const team = resolveTeam(load.file, r.agents);
  cached = { mtimeMs: load.mtimeMs ?? 0, rosterKey: r.key, team };
  lastValidTeam = team;
  logger.info({
    msg: 'team.loaded',
    agents: team.order.length,
    unlisted: team.unlisted.map((u) => u.name),
    missing: team.missing,
    warnings: team.warnings.length,
  });
  return team;
}

/** The `# Your team` block for one agent, or '' when the feature is off. */
export async function buildTeamBlock(agent: string): Promise<string> {
  const team = await getResolvedTeam();
  if (!team) return '';
  return renderTeamBlock(team, agent) ?? '';
}
