// tmux attention watcher — main-server-only poll loop.
//
// Watches the tmux sessions somora created — locally and on SSH
// resources — in which a coding agent runs (recognised by its process,
// detection/), unless attention was switched off at create. Each tick:
// look at the pane, read the agent's state with herdr's rules, feed the
// pure state machine (attention.ts) and act:
//
//   event        → mirror needs_attention for tool responses
//   observed     → the origin saw it itself, nothing to do
//   wake         → dispatch a turn to the ORIGIN (agent, session):
//                  the agent finished, or it waits at a dialog
//   cap_reached  → flag only, no more turns today for this session
//
// Runs ONLY in the main server (wired at boot via
// configureTmuxAttention + startTmuxAttentionWatcher) — MCP children
// never start it, so the runChatTurn deps need no HTTP fallback.
// Design: private/tmux-hooks-design.md §3.

import { logger } from '../server/logger.ts';
import { startTurn } from '../server/start-turn.ts';
import type { ChatTurnResolveDeps } from '../server/run-turn-types.ts';
import { getSessionLockStatus } from '../server/session-queue.ts';
import type { TmuxAttentionConfig } from '../config/types.ts';
import { localRunner, tmuxLocalList } from '../tools/tmux/local.ts';
import { remoteRunner, tmuxRemoteList } from '../tools/tmux/remote.ts';
import { listTmuxOrigins, originKey, type TmuxOrigin } from './origin-store.ts';
import { agentStateOf, observePane } from './observe.ts';
import {
  paneStateOf,
  initialAttentionState,
  readTmuxObservations,
  stepAttention,
  toDisplay,
  writeAttentionMirror,
  type AttentionSessionState,
} from './attention.ts';

type ChatTurnDeps = ChatTurnResolveDeps;
type PublishEvent = (agent: string, session: string, event: unknown) => Promise<void> | void;

let injectedChatTurnDeps: ChatTurnDeps | null = null;

/** Server boot wires runChatTurn deps + the SSE publisher here — same
 *  pattern as configureSentinel. publishEvent is mandatory-by-lesson
 *  (feedback_publishsse_must_broadcast): without it a wake turn lands
 *  in the JSONL but open clients only see it after a reload. */
export function configureTmuxAttention(args: {
  chatTurnDeps: ChatTurnDeps;
  publishEvent?: PublishEvent;
}): void {
  injectedChatTurnDeps = args.chatTurnDeps;
  // publishEvent is accepted for compatibility and not used: the wake
  // turn streams through startTurn's boot-wired broadcast since 2026-09-13.
}

/** The record line and, beside it, what to do (turn-framing.ts). */
/** "6 min", "45 s" — the length of a task in the wake line. */
export function taskLength(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export function wakePrompt(
  name: string,
  agent: string,
  reason: 'ready' | 'blocked',
  target?: string,
  taskMs?: number | null,
): { text: string; prefix: string } {
  const where = target && target !== 'local' ? ` on ${target}` : '';
  const ref = `name: "${name}"${target && target !== 'local' ? `, target: "${target}"` : ''}`;
  if (reason === 'blocked') {
    return {
      text: `[tmux attention] Session '${name}'${where} (${agent}) needs an answer: it stopped at a dialog.`,
      prefix:
        `The coding agent in the tmux session named below waits at an approval, question or startup ` +
        `dialog. You started it earlier. Handle it now:\n` +
        `1. tmux (action: capture, ${ref}) to read the dialog.\n` +
        `2. Decide, or ask the person when it is theirs to decide; answer with tmux send (key: or keys:).\n` +
        `Never approve something you do not understand.`,
    };
  }
  return {
    text: `[tmux attention] Session '${name}'${where} (${agent}) stopped working and is idle${taskMs ? ` after ${taskLength(taskMs)}` : ''}.`,
    prefix:
      `The coding agent in the tmux session named below was working and is idle now. That usually means ` +
      `it finished — but a turn can also stop half-way (an error, a model that wrote a tool call as text). ` +
      `You started it earlier and your last look predates this. Inspect it now:\n` +
      `1. tmux (action: read, ${ref}) to read its answer, and check its status report if you asked for one.\n` +
      `2. Decide: prompt it again, report the result to the person, or kill the session when done.\n` +
      `Do not blindly send a new prompt — read first.`,
  };
}

async function tmuxSessionExists(origin: TmuxOrigin): Promise<boolean> {
  try {
    const list = origin.target ? await tmuxRemoteList(origin.agent, origin.target) : await tmuxLocalList();
    return list.ok && list.sessions.some((s) => s.name === origin.name);
  } catch {
    return false;
  }
}

export class TmuxAttentionWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly states = new Map<string, AttentionSessionState>();
  /** The agent last recognised per session (for the wake text). */
  private readonly agents = new Map<string, string>();
  private ticking = false;
  private lastMirror = '';

  constructor(private readonly config: TmuxAttentionConfig) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollMs);
    // Don't keep the process alive just for the watcher.
    this.timer.unref?.();
    logger.info({
      msg: 'tmux.attention_watcher_started',
      pollMs: this.config.pollMs,
      wake: this.config.wake,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle. Public for tests / manual triggering. */
  async tick(): Promise<void> {
    if (this.ticking) return; // a slow tmux call must not stack ticks
    this.ticking = true;
    try {
      await this.tickInner();
    } catch (err) {
      logger.warn({ msg: 'tmux.attention_tick_failed', err: (err as Error).message });
    } finally {
      this.ticking = false;
    }
  }

  /** The live session names per target (local and each SSH resource
   *  with origins). A target that cannot be asked is left out this tick. */
  private async liveSessions(origins: TmuxOrigin[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    const local = await tmuxLocalList();
    if (local.ok) out.set('local', new Set(local.sessions.map((s) => s.name)));
    const remotes = new Map<string, string>(); // target → an agent allowed to use it
    for (const o of origins) if (o.target && !remotes.has(o.target)) remotes.set(o.target, o.agent);
    for (const [target, agent] of remotes) {
      try {
        const r = await tmuxRemoteList(agent, target);
        if (r.ok) out.set(target, new Set(r.sessions.map((s) => s.name)));
      } catch (err) {
        logger.debug({ msg: 'tmux.attention_remote_list_failed', target, err: (err as Error).message });
      }
    }
    return out;
  }

  private async tickInner(): Promise<void> {
    const origins = listTmuxOrigins().filter((o) => o.attention !== false);
    const live = await this.liveSessions(origins);
    // Dead sessions drop out of the state map, so a recreated same-name
    // session starts from a fresh baseline. A target that could not be
    // asked keeps its states.
    const watched = origins.filter((o) => live.get(o.target ?? 'local')?.has(o.name));
    const watchedKeys = new Set(watched.map((o) => originKey(o.target, o.name)));
    for (const known of [...this.states.keys()]) {
      const target = known.startsWith('@') ? known.slice(1, known.indexOf('/')) : 'local';
      if (live.has(target) && !watchedKeys.has(known)) this.states.delete(known);
    }
    if (watched.length === 0) {
      this.mirror();
      return;
    }

    const observations = readTmuxObservations();
    const now = Date.now();

    for (const origin of watched) {
      const key = originKey(origin.target, origin.name);
      const run = origin.target ? remoteRunner(origin.agent, origin.target) : localRunner;
      const o = await observePane(run, origin.name, { lines: 1 });
      if ('error' in o) continue; // vanished mid-tick — next tick prunes it
      const agentState = agentStateOf(o.look, origin.kind);
      if (!agentState) {
        // No coding agent (a shell, or the agent exited): nothing to watch.
        this.states.delete(key);
        continue;
      }
      this.agents.set(key, agentState.name);

      const originRef = {
        agent: origin.agent,
        ...(origin.session ? { session: origin.session } : {}),
      };
      const busy =
        origin.session !== undefined
          ? getSessionLockStatus(origin.agent, origin.session).activeTurnId !== undefined
          : false;

      const prev = this.states.get(key) ?? initialAttentionState();
      const { state, action } = stepAttention({
        state: prev,
        tuiState: paneStateOf(agentState.state),
        rule: agentState.rule ?? null,
        now,
        observation: observations[key] ?? null,
        origin: originRef,
        originBusy: busy,
        config: this.config,
      });
      this.states.set(key, state);

      if (action.kind === 'event') {
        logger.info({ msg: 'tmux.attention_event', name: origin.name, origin: originRef });
      } else if (action.kind === 'observed') {
        logger.info({ msg: 'tmux.attention_observed', name: origin.name, origin: originRef });
      } else if (action.kind === 'cap_reached') {
        logger.warn({
          msg: 'tmux.attention_cap_reached',
          name: origin.name,
          cap: this.config.dailyCapPerSession,
        });
      } else if (action.kind === 'wake') {
        logger.info({
          msg: 'tmux.attention_wake',
          name: origin.name,
          ...(origin.target ? { target: origin.target } : {}),
          reason: action.reason,
          agent: agentState.name,
          origin: originRef,
          wakesToday: state.wakesToday,
        });
        this.dispatchWake(origin, agentState.name, action.reason, state.lastTaskMs);
      }
    }

    this.mirror();
  }

  /** Write the display mirror when it changed (tool layer + web read it). */
  private mirror(): void {
    const map: Record<string, ReturnType<typeof toDisplay>> = {};
    for (const [name, s] of this.states) map[name] = toDisplay(s);
    const serialized = JSON.stringify(map);
    if (serialized === this.lastMirror) return;
    this.lastMirror = serialized;
    writeAttentionMirror(map);
  }

  /** Fire-and-forget wake turn on the origin (agent, session). */
  private dispatchWake(origin: TmuxOrigin, agentName: string, reason: 'ready' | 'blocked', taskMs: number | null): void {
    const deps = injectedChatTurnDeps;
    const session = origin.session;
    if (!deps || !session) {
      // No session recorded (old origin entry) or boot wiring missing —
      // the needs_attention flag still surfaces it, just no turn.
      logger.warn({
        msg: 'tmux.attention_wake_skipped',
        name: origin.name,
        reason: !deps ? 'not configured' : 'origin has no session id',
      });
      return;
    }
    // Lock, abort registration, turn id and the SSE broadcast are
    // startTurn's; the wake only says who, where and what.
    const wake = wakePrompt(origin.name, agentName, reason, origin.target, reason === 'ready' ? taskMs : null);
    void startTurn({
      agent: origin.agent,
      session,
      text: wake.text,
      turnPrefix: wake.prefix,
      origin: { kind: 'tmux', tmuxSession: origin.name, tmuxKind: agentName },
      deps,
      // The lock wait can be long — the origin's own turn typically
      // holds it, and that turn is often the one that `tmux kill`s the
      // session once the work is done. Waking for a session that no
      // longer exists burns a turn and confuses the agent ("became
      // ready" → `tmux list` → 0). Re-check liveness AFTER the wait.
      beforeRun: async () => {
        if (await tmuxSessionExists(origin)) return true;
        logger.info({
          msg: 'tmux.attention_wake_stale',
          name: origin.name,
          origin: { agent: origin.agent, session },
          reason: 'session gone before wake turn could start',
        });
        return false;
      },
    }).catch((err) => {
      logger.warn({
        msg: 'tmux.attention_wake_failed',
        name: origin.name,
        err: (err as Error).message,
      });
    });
  }
}

let watcher: TmuxAttentionWatcher | null = null;

export function startTmuxAttentionWatcher(config: TmuxAttentionConfig): void {
  if (watcher) return;
  watcher = new TmuxAttentionWatcher(config);
  watcher.start();
}
