// Moved unchanged from src/server/index.ts, which calls registerTeamRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import { listAgents, loadPersona } from '../../persona/loader.ts';
import { renderTeamBlock, renderTeamBlockCompact } from '../../team/render.ts';
import { parseTeamFile, resolveTeam } from '../../team/resolve.ts';
import { getResolvedTeam, loadTeamFile, teamFilePath, teamRoster } from '../../team/store.ts';
import type { ResolvedTeam } from '../../team/types.ts';
import { initialTeamFile, writeTeamFile } from '../../team/write.ts';
import type { AgentKind } from '../../tools/gating.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';

export function registerTeamRoutes(app: Hono): void {
  // ── Team (team.yaml → "# Your team" block) ─────────────────────────
  // Read side of the org chart. Phase 1 is read-only over HTTP; the file
  // is edited by hand (docs/team.md) — PUT /team arrives with the web
  // Team window (Phase 2).
  app.get('/team', async (c) => c.json(await teamResponse()));

  async function teamResponse(): Promise<Record<string, unknown>> {
    const load = await loadTeamFile();
    const team = await getResolvedTeam();
    return {
      enabled: team !== null,
      path: teamFilePath(),
      exists: load.exists,
      valid: load.file !== null,
      issues: load.issues,
      ...(load.file ? { file: load.file } : {}),
      ...(team
        ? {
            principal: team.principal,
            rules: team.rules,
            agents: team.agents,
            order: team.order,
            unlisted: team.unlisted,
            missing: team.missing,
            warnings: team.warnings,
          }
        : {}),
    };
  }

  // Write side (web Team window). The whole document is replaced; the
  // server validates exactly like the loader, writes atomically and keeps
  // the last five versions as team.yaml.bak-<ts>.
  app.put('/team', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON body required' }, 400);
    const parsed = parseTeamFile(body);
    if (!parsed.file) return c.json({ error: 'team.yaml would be invalid — nothing written', issues: parsed.issues }, 400);
    const { backup } = await writeTeamFile(parsed.file);
    logger.info({ msg: 'team.saved', agents: Object.keys(parsed.file.agents).length, backup });
    return c.json({ ok: true, backup, ...(await teamResponse()) });
  });

  // Bootstrap without a terminal: a first document from the agents on
  // disk. 409 when a file exists — this never overwrites.
  app.post('/team/init', async (c) => {
    const load = await loadTeamFile();
    if (load.exists) return c.json({ error: 'team.yaml already exists' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { principal?: string };
    const name = typeof body.principal === 'string' && body.principal.trim() ? body.principal.trim() : 'Principal';
    const agents = (await teamRoster()).map((a) => ({ name: a.name, role: a.role, description: a.description }));
    if (agents.length === 0) return c.json({ error: 'no agents on disk' }, 400);
    await writeTeamFile(initialTeamFile(agents, name));
    logger.info({ msg: 'team.initialised', agents: agents.length, principal: name });
    return c.json({ ok: true, ...(await teamResponse()) });
  });

  // Render a DRAFT (unsaved) document for one agent — the editor's live
  // preview. Validation errors come back as issues, nothing is written.
  // The block an agent really gets: a builder carries the compact version
  // (names, titles, rules), everyone else the full one — the preview and
  // the check must say the same as the prompt.
  function teamBlockFor(team: ResolvedTeam, agent: string, kind: AgentKind | undefined): string | null {
    return kind === 'builder' ? renderTeamBlockCompact(team, agent) : renderTeamBlock(team, agent);
  }

  app.post('/team/preview', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { file?: unknown; agent?: string } | null;
    if (!body || typeof body.agent !== 'string') return c.json({ error: 'body {file, agent} required' }, 400);
    const parsed = parseTeamFile(body.file ?? {});
    if (!parsed.file) return c.json({ agent: body.agent, valid: false, issues: parsed.issues, block: '' });
    const team = resolveTeam(parsed.file, await teamRoster());
    const block = teamBlockFor(team, body.agent, (await loadPersona(body.agent))?.kind) ?? '';
    return c.json({ agent: body.agent, valid: true, issues: [], warnings: team.warnings, block, chars: block.length, softMaxChars: config.promptBudgets.teamBlockChars });
  });

  app.get('/team/preview/:agent', async (c) => {
    const agent = c.req.param('agent');
    const previewPersona = await loadPersona(agent);
    if (!previewPersona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const team = await getResolvedTeam();
    if (!team) return c.json({ agent, enabled: false, block: '' });
    const block = teamBlockFor(team, agent, previewPersona.kind) ?? '';
    return c.json({ agent, enabled: true, block, chars: block.length, softMaxChars: config.promptBudgets.teamBlockChars });
  });

  app.get('/team/check', async (c) => {
    const load = await loadTeamFile();
    const team = await getResolvedTeam();
    const kindByName = new Map((await listAgents()).map((a) => [a.name, a.kind] as const));
    // External agents get no block of their own: nothing to measure.
    const blocks = team
      ? team.order.filter((name) => team.agents[name]?.kind !== 'external').map((name) => {
          const chars = (teamBlockFor(team, name, kindByName.get(name)) ?? '').length;
          return { agent: name, chars, overSoftMax: chars > config.promptBudgets.teamBlockChars };
        })
      : [];
    return c.json({
      exists: load.exists,
      valid: load.file !== null,
      issues: load.issues,
      warnings: team?.warnings ?? [],
      unlisted: team?.unlisted ?? [],
      missing: team?.missing ?? [],
      blocks,
      softMaxChars: config.promptBudgets.teamBlockChars,
    });
  });
}
