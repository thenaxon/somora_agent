// Slash-command dispatcher. Returns a list of "actions" the App applies:
//   - notice:      append a system Turn (info/warn/error)
//   - switchTo:    change agent/session, restart stream
//   - exit:        leave the program
//   - clearStats:  drop session-scoped stats (e.g. after /reset)
//   - setShow:     flip a TUI display toggle (memory / tools)
// The dispatcher is intentionally pure-ish: it makes HTTP calls but doesn't
// touch React state. The App turns the actions into setState calls.

import type { Api } from './api.ts';

export type ShowTarget = 'memory' | 'tools';
export type VerboseTarget = 'tools' | 'memory' | 'system';

export type CommandAction =
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'switchTo'; agent: string; session: string }
  | { kind: 'exit' }
  | { kind: 'clearStats' }
  | { kind: 'setShow'; target: ShowTarget; value: boolean }
  | { kind: 'setVerbose'; target: VerboseTarget; value: boolean };

export interface CommandMeta {
  name: string;   // the bare slash command (used for prefix-match)
  usage: string;  // user-facing display in the autocomplete popup
}

// Surfaced via the slash-autocomplete popup. Order = display order.
export const COMMANDS: readonly CommandMeta[] = [
  { name: '/help', usage: '/help' },
  { name: '/agents', usage: '/agents' },
  { name: '/agent', usage: '/agent <name> [session]' },
  { name: '/sessions', usage: '/sessions' },
  { name: '/session', usage: '/session <slug-or-id>' },
  { name: '/new', usage: '/new <slug>' },
  { name: '/main', usage: '/main' },
  { name: '/reset', usage: '/reset [YES]' },
  { name: '/models', usage: '/models' },
  { name: '/model', usage: '/model [<alias>|default]' },
  { name: '/show', usage: '/show [memory|tools] [on|off]' },
  { name: '/verbose', usage: '/verbose [tools|memory|system] [on|off]' },
  { name: '/thinking', usage: '/thinking [off|low|medium|high|default]' },
  { name: '/quit', usage: '/quit' },
  { name: '/exit', usage: '/exit' },
];

// Returns commands whose name starts with the given prefix (typically the
// raw input value while the user is still typing the command name —
// caller should bail out if there's already a space in the input,
// meaning the user is typing args, not the command name).
export function matchCommands(prefix: string): CommandMeta[] {
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

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
  /show                       — show current display toggles
  /show memory on|off         — show/hide [memory · …] inject lines (display only)
  /show tools on|off          — show/hide [tool call · …] / [tool result · …] lines
  /verbose                    — show current verbose toggles
  /verbose tools on|off       — full tool input/output payloads under each call/result
  /verbose memory on|off      — full memory inject text under each [memory · …] line
  /verbose system on          — print persona system prompt as a one-shot block
  /verbose system off         — clear the verbose-system flag (no effect on past blocks)
  /thinking                   — show effective thinking depth + source
  /thinking <level>           — set thinking depth for this session: off|low|medium|high
  /thinking default           — clear session override, fall back to persona/engine default
  /quit, /exit                — leave somora`;

export interface CommandContext {
  api: Api;
  agent: string;
  session: string;
  showMemory: boolean;
  showTools: boolean;
  verboseTools: boolean;
  verboseMemory: boolean;
  verboseSystem: boolean;
}

export async function runCommand(
  line: string,
  ctx: CommandContext,
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
      const agents = await ctx.api.fetchAgents();
      if (!agents.find((a) => a.name === name)) {
        out.push({
          kind: 'notice',
          text: `agent '${name}' not found. /agents to list.`,
          tone: 'warn',
        });
        return out;
      }
      const sessionRef = args[1] ?? 'main';
      if (sessionRef !== 'main') {
        const sessions = await ctx.api.fetchSessions(name);
        if (!sessions.find((s) => s.id === sessionRef || s.slug === sessionRef)) {
          out.push({
            kind: 'notice',
            text: `session '${sessionRef}' not found for agent '${name}'. /sessions to list, or /new <slug>.`,
            tone: 'warn',
          });
          return out;
        }
      }
      out.push({ kind: 'switchTo', agent: name, session: sessionRef });
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
      if (ref !== 'main') {
        const sessions = await ctx.api.fetchSessions(ctx.agent);
        if (!sessions.find((s) => s.id === ref || s.slug === ref)) {
          out.push({
            kind: 'notice',
            text: `session '${ref}' not found. /sessions to list, or /new <slug>.`,
            tone: 'warn',
          });
          return out;
        }
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

    case '/thinking': {
      const arg = args[0];
      if (!arg) {
        const info = await ctx.api.fetchSessionThinking(ctx.agent, ctx.session);
        if (!info) {
          out.push({ kind: 'notice', text: 'could not fetch thinking state', tone: 'error' });
          return out;
        }
        const eff = info.effective ?? '(engine default)';
        const sourcePart =
          info.source === 'session-override'
            ? ` — session-override (persona default: ${info.personaDefault ?? '(none)'})`
            : info.source === 'persona-default'
              ? ' — persona default'
              : ' — no setting, engine default';
        const dormantPart = info.effective && !info.modelSupportsReasoning
          ? `\n  warning: active model has no 'reasoning' capability — setting is dormant`
          : '';
        out.push({
          kind: 'notice',
          text: `Thinking: ${eff}${sourcePart}${dormantPart}`,
          tone: info.effective && !info.modelSupportsReasoning ? 'warn' : 'info',
        });
        return out;
      }
      if (arg === 'default' || arg === '-') {
        try {
          await ctx.api.clearSessionThinking(ctx.agent, ctx.session);
          out.push({
            kind: 'notice',
            text: 'thinking override cleared, back to persona/engine default',
            tone: 'info',
          });
        } catch (err) {
          out.push({ kind: 'notice', text: (err as Error).message, tone: 'error' });
        }
        return out;
      }
      if (arg !== 'off' && arg !== 'low' && arg !== 'medium' && arg !== 'high') {
        out.push({
          kind: 'notice',
          text: `usage: /thinking off|low|medium|high|default`,
          tone: 'warn',
        });
        return out;
      }
      try {
        await ctx.api.setSessionThinking(ctx.agent, ctx.session, arg);
        // Probe support so we can be honest in the response notice.
        const info = await ctx.api.fetchSessionThinking(ctx.agent, ctx.session);
        const dormantPart =
          info && !info.modelSupportsReasoning
            ? ` (active model has no 'reasoning' capability — dormant until you switch model)`
            : '';
        out.push({
          kind: 'notice',
          text: `thinking set to: ${arg}${dormantPart}`,
          tone: info && !info.modelSupportsReasoning ? 'warn' : 'info',
        });
      } catch (err) {
        out.push({ kind: 'notice', text: (err as Error).message, tone: 'error' });
      }
      return out;
    }

    case '/verbose': {
      const target = args[0];
      const value = args[1];
      if (!target) {
        out.push({
          kind: 'notice',
          text:
            `Verbose toggles (TUI render only — server already streams full payloads):\n` +
            `  tools:  ${ctx.verboseTools ? 'on' : 'off'}  — full input/output under each call\n` +
            `  memory: ${ctx.verboseMemory ? 'on' : 'off'}  — full inject text under [memory · …]\n` +
            `  system: ${ctx.verboseSystem ? 'on' : 'off'}  — last /verbose system on flag\n` +
            `Toggle: /verbose <tools|memory|system> on|off`,
          tone: 'info',
        });
        return out;
      }
      if (target !== 'tools' && target !== 'memory' && target !== 'system') {
        out.push({
          kind: 'notice',
          text: 'usage: /verbose [tools|memory|system] [on|off]',
          tone: 'warn',
        });
        return out;
      }
      if (value !== 'on' && value !== 'off') {
        out.push({
          kind: 'notice',
          text: `usage: /verbose ${target} on|off`,
          tone: 'warn',
        });
        return out;
      }
      const flag = value === 'on';
      out.push({ kind: 'setVerbose', target, value: flag });
      // For `system`, switching on triggers a one-shot fetch + display
      // of the persona system prompt. Future system blocks are not
      // streamed automatically (system prompt is static per agent).
      if (target === 'system' && flag) {
        try {
          const sp = await ctx.api.fetchSystemPrompt(ctx.agent);
          if (sp) {
            out.push({
              kind: 'notice',
              text: `[system prompt for ${ctx.agent}]\n${sp}`,
              tone: 'info',
            });
          } else {
            out.push({
              kind: 'notice',
              text: `could not fetch system prompt for ${ctx.agent}`,
              tone: 'warn',
            });
          }
        } catch (err) {
          out.push({ kind: 'notice', text: (err as Error).message, tone: 'error' });
        }
      } else {
        out.push({
          kind: 'notice',
          text: `verbose ${target} ${flag ? 'on' : 'off'}`,
          tone: 'info',
        });
      }
      return out;
    }

    case '/show': {
      const target = args[0];
      const value = args[1];
      if (!target) {
        out.push({
          kind: 'notice',
          text:
            `Display toggles (TUI render only — server still injects/runs everything):\n` +
            `  memory: ${ctx.showMemory ? 'on' : 'off'}\n` +
            `  tools:  ${ctx.showTools ? 'on' : 'off'}\n` +
            `Toggle: /show memory on|off  /show tools on|off`,
          tone: 'info',
        });
        return out;
      }
      if (target !== 'memory' && target !== 'tools') {
        out.push({
          kind: 'notice',
          text: `usage: /show [memory|tools] [on|off]`,
          tone: 'warn',
        });
        return out;
      }
      if (value !== 'on' && value !== 'off') {
        out.push({
          kind: 'notice',
          text: `usage: /show ${target} on|off`,
          tone: 'warn',
        });
        return out;
      }
      const flag = value === 'on';
      out.push({ kind: 'setShow', target, value: flag });
      out.push({
        kind: 'notice',
        text: `${target} display ${flag ? 'on' : 'off'}`,
        tone: 'info',
      });
      return out;
    }

    default:
      out.push({ kind: 'notice', text: `unknown command: ${cmd}. Try /help`, tone: 'warn' });
      return out;
  }
}
