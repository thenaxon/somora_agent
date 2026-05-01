// Slash-command dispatcher. Returns a list of "actions" the App applies:
//   - notice:      append a system Turn (info/warn/error)
//   - switchTo:    change agent/session, restart stream
//   - exit:        leave the program
//   - clearStats:  drop session-scoped stats (e.g. after /reset)
// The dispatcher is intentionally pure-ish: it makes HTTP calls but doesn't
// touch React state. The App turns the actions into setState calls.

import type { Api } from './api.ts';

export type CommandAction =
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'switchTo'; agent: string; session: string }
  | { kind: 'exit' }
  | { kind: 'clearStats' };

const HELP_TEXT = `Available commands:
  /help                       — show this help
  /agents                     — list agents
  /agent <name> [session]     — switch agent (defaults to main session)
  /sessions                   — list sessions of current agent
  /session <slug-or-id>       — switch to another session of current agent
  /new <slug>                 — create new session and switch to it
  /main                       — back to main session of current agent
  /reset                      — preview reset of current session
  /reset YES                  — archive current session, start fresh
  /models                     — list all configured models with aliases
  /model                      — show current effective model for this session
  /model <alias-or-ref>       — override model for this session
  /model default              — clear override, fall back to persona model
  /quit, /exit                — leave somora`;

export async function runCommand(
  line: string,
  ctx: { api: Api; agent: string; session: string },
): Promise<CommandAction[]> {
  const [cmd, ...args] = line.split(/\s+/);
  const out: CommandAction[] = [];

  switch (cmd) {
    case '/help':
      out.push({ kind: 'notice', text: HELP_TEXT, tone: 'info' });
      return out;

    case '/quit':
    case '/exit':
      out.push({ kind: 'exit' });
      return out;

    case '/agents': {
      const agents = await ctx.api.fetchAgents();
      const lines = ['Agents:'];
      for (const a of agents) {
        const marker = a.name === ctx.agent ? '*' : ' ';
        const icon = a.icon ? `${a.icon} ` : '';
        const desc = a.description ? ` — ${a.description}` : '';
        lines.push(`  ${marker} ${icon}${a.name}${desc}`);
      }
      out.push({ kind: 'notice', text: lines.join('\n'), tone: 'info' });
      return out;
    }

    case '/agent': {
      const name = args[0];
      if (!name) {
        out.push({ kind: 'notice', text: 'usage: /agent <name> [session]', tone: 'warn' });
        return out;
      }
      out.push({ kind: 'switchTo', agent: name, session: args[1] ?? 'main' });
      return out;
    }

    case '/sessions': {
      const sessions = await ctx.api.fetchSessions(ctx.agent);
      const lines = [`Sessions for ${ctx.agent}:`];
      for (const s of sessions) {
        const marker = s.id === ctx.session || s.slug === ctx.session ? '*' : ' ';
        const stamp = s.lastActivity ? s.lastActivity.slice(0, 16).replace('T', ' ') : 'empty';
        lines.push(`  ${marker} ${s.slug.padEnd(24)}  ${String(s.messageCount).padStart(3)} msgs  ${stamp}`);
      }
      out.push({ kind: 'notice', text: lines.join('\n'), tone: 'info' });
      return out;
    }

    case '/session': {
      const ref = args[0];
      if (!ref) {
        out.push({ kind: 'notice', text: 'usage: /session <slug-or-id>', tone: 'warn' });
        return out;
      }
      out.push({ kind: 'switchTo', agent: ctx.agent, session: ref });
      return out;
    }

    case '/new': {
      const slug = args[0];
      if (!slug) {
        out.push({ kind: 'notice', text: 'usage: /new <slug>', tone: 'warn' });
        return out;
      }
      try {
        const id = await ctx.api.createSession(ctx.agent, slug);
        out.push({ kind: 'switchTo', agent: ctx.agent, session: id });
      } catch (err) {
        out.push({ kind: 'notice', text: (err as Error).message, tone: 'error' });
      }
      return out;
    }

    case '/main':
      out.push({ kind: 'switchTo', agent: ctx.agent, session: 'main' });
      return out;

    case '/reset': {
      if (args[0] !== 'YES') {
        const altHint =
          ctx.session !== 'main'
            ? `\n        Alternative for non-main sessions: /new <new-slug>` +
              `\n        leaves this session intact and starts a fresh one.`
            : '';
        const text =
          `[/reset] would archive the CURRENT session (${ctx.agent}:${ctx.session}) and start fresh.` +
          `\n        Existing JSONL + meta are preserved as a timestamped archive` +
          `\n        you can resume any time with /session <id>.` +
          altHint +
          `\n        To commit: /reset YES`;
        out.push({ kind: 'notice', text, tone: 'info' });
        return out;
      }
      try {
        const result = await ctx.api.resetSession(ctx.agent, ctx.session);
        if (result.archivedId) {
          const dreamLine = result.dreamSpawned
            ? `\n             dream-extraction running in background — ask later via dream_list.`
            : '';
          out.push({
            kind: 'notice',
            text:
              `[reset done] archived as: ${result.archivedId}` +
              `\n             current session is now empty + clean.${dreamLine}`,
            tone: 'info',
          });
        } else {
          out.push({
            kind: 'notice',
            text: `[reset noop] ${result.reason ?? 'nothing to archive'}`,
            tone: 'warn',
          });
        }
        out.push({ kind: 'clearStats' });
      } catch (err) {
        out.push({ kind: 'notice', text: (err as Error).message, tone: 'error' });
      }
      return out;
    }

    case '/models': {
      const models = await ctx.api.fetchModels();
      const aliasW = Math.max(5, ...models.map((m) => (m.alias ?? '-').length));
      const refW = Math.max(20, ...models.map((m) => `${m.provider}/${m.id}`.length));
      const lines = [
        'Models:',
        `  ${'alias'.padEnd(aliasW)}  ${'provider/id'.padEnd(refW)}  engine                 ctx     caps`,
      ];
      for (const m of models) {
        const alias = (m.alias ?? '-').padEnd(aliasW);
        const ref = `${m.provider}/${m.id}`.padEnd(refW);
        const engine = m.engine.padEnd(22);
        const ctx2 = `${(m.contextWindow / 1000).toFixed(0)}k`.padStart(6);
        const caps = m.capabilities.join(',');
        lines.push(`  ${alias}  ${ref}  ${engine}  ${ctx2}  ${caps}`);
      }
      out.push({ kind: 'notice', text: lines.join('\n'), tone: 'info' });
      return out;
    }

    case '/model': {
      const ref = args[0];
      if (!ref) {
        const info = await ctx.api.fetchSessionModel(ctx.agent, ctx.session);
        if (!info) {
          out.push({ kind: 'notice', text: 'could not fetch session model', tone: 'error' });
        } else {
          const aliasPart = info.alias ? ` (alias: ${info.alias})` : '';
          const sourcePart =
            info.source === 'session-override'
              ? ` — session-override (persona default: ${info.personaDefault ?? '(none)'})`
              : ' — persona default';
          out.push({
            kind: 'notice',
            text: `Effective: ${info.provider}/${info.modelId}${aliasPart}\n  engine: ${info.engine}, context: ${info.contextWindow}${sourcePart}`,
            tone: 'info',
          });
        }
        return out;
      }
      if (ref === 'default' || ref === '-') {
        try {
          await ctx.api.clearSessionModel(ctx.agent, ctx.session);
          out.push({ kind: 'notice', text: 'model override cleared, back to persona default', tone: 'info' });
        } catch (err) {
          out.push({ kind: 'notice', text: (err as Error).message, tone: 'error' });
        }
        return out;
      }
      try {
        await ctx.api.setSessionModel(ctx.agent, ctx.session, ref);
        out.push({
          kind: 'notice',
          text: `model set to: ${ref} (for session ${ctx.session})`,
          tone: 'info',
        });
      } catch (err) {
        out.push({ kind: 'notice', text: (err as Error).message, tone: 'error' });
      }
      return out;
    }

    default:
      out.push({ kind: 'notice', text: `unknown command: ${cmd}. Try /help`, tone: 'warn' });
      return out;
  }
}
