// Writing team.yaml: the web Team window (PUT /team) and the bootstrap
// (POST /team/init, `somora team init`) go through here. Atomic
// (tmp + rename), keeps the last five versions as `team.yaml.bak-<ts>`,
// and drops the read cache so the next turn sees the new file.

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { copyFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import { resetTeamCache, teamFilePath } from './store.ts';
import { DEFAULT_TEAM_RULES, TEAM_FILE_NAME, type TeamAgentInfo, type TeamFile } from './types.ts';

const KEEP_BACKUPS = 5;

const HEADER =
  '# somora team — who is who, who reports to whom, who to involve for what.\n' +
  '# Rendered into every agent\'s system prompt as "# Your team" (see docs/team.md).\n' +
  '# Edit by hand or in the web Team window; agents read it, they never write it.\n';

/** Serialise a validated document. Keys in a stable, readable order. */
export function teamFileToYaml(file: TeamFile): string {
  const ordered = {
    version: file.version,
    principal: file.principal,
    ...(file.rules ? { rules: file.rules } : {}),
    agents: Object.fromEntries(
      Object.entries(file.agents).map(([name, a]) => [
        name,
        {
          reports_to: a.reports_to,
          ...(a.title ? { title: a.title } : {}),
          ...(a.active === false ? { active: false } : {}),
          ...(a.involve_for && a.involve_for.length > 0 ? { involve_for: a.involve_for } : {}),
          ...(a.not_for && a.not_for.length > 0 ? { not_for: a.not_for } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
        },
      ]),
    ),
  };
  return HEADER + dumpYaml(ordered, { lineWidth: 100, noRefs: true, quotingType: '"' });
}

function ts(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function rotateBackups(dir: string): void {
  const baks = readdirSync(dir)
    .filter((f) => f.startsWith(`${TEAM_FILE_NAME}.bak-`))
    .sort();
  while (baks.length > KEEP_BACKUPS) {
    const victim = baks.shift()!;
    try {
      unlinkSync(join(dir, victim));
    } catch {
      /* best effort */
    }
  }
}

/** Write the file atomically; the previous version becomes a backup. */
export async function writeTeamFile(file: TeamFile): Promise<{ path: string; backup: string | null }> {
  const path = teamFilePath();
  const dir = dirname(path);
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.bak-${ts()}`;
    await copyFile(path, backup);
    rotateBackups(dir);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, teamFileToYaml(file), 'utf8');
  await rename(tmp, path);
  resetTeamCache();
  return { path, backup };
}

/** A first document: every agent under the principal, titles from the
 *  frontmatter, the default rules spelled out so the operator can edit
 *  them. Shared by `somora team init` and POST /team/init. */
export function initialTeamFile(agents: TeamAgentInfo[], principalName: string): TeamFile {
  const file: TeamFile = {
    version: 1,
    principal: { name: principalName, title: 'Principal' },
    rules: [...DEFAULT_TEAM_RULES],
    agents: {},
  };
  for (const a of agents) {
    file.agents[a.name] = {
      reports_to: 'principal',
      ...(a.role ? { title: a.role } : {}),
    };
  }
  return file;
}
