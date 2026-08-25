// tmux attention watcher — main-server-only poll loop.
//
// Watches somora-created LOCAL tmux sessions whose origin record
// declares a coding-CLI kind (claude-code / codex) and attention was
// not opted out at create time. Each tick: capture the pane tail, run
// detectTuiState, feed the pure state machine (attention.ts) and act:
//
//   event        → mirror needs_attention for tool responses / web badge
//   observed     → origin saw the completion itself, nothing to do
//   wake         → dispatch a turn to the ORIGIN (agent, session):
//                  "session X became ready — read the output, continue"
//   cap_reached  → flag only, no more turns today for this session
//
// Runs ONLY in the main server (wired at boot via
// configureTmuxAttention + startTmuxAttentionWatcher) — MCP children
// never start it, so the runChatTurn deps need no HTTP fallback.
// Design: private/tmux-hooks-design.md §3.

import { logger } from '../server/logger.ts';
import { runChatTurn } from '../server/run-turn.ts';
import { acquireSessionLock, getSessionLockStatus } from '../server/session-queue.ts';
import type { TmuxAttentionConfig } from '../config/types.ts';
import { tmuxLocalCapture, tmuxLocalList } from '../tools/tmux/local.ts';
import { listTmuxOrigins, type TmuxOrigin } from './origin-store.ts';
import { detectTuiState } from './tui-markers.ts';
import {
  initialAttentionState,
  readTmuxObservations,
  stepAttention,
  toDisplay,
  writeAttentionMirror,
  type AttentionSessionState,
} from './attention.ts';

type ChatTurnDeps = Parameters<typeof runChatTurn>[0]['deps'];
type PublishEvent = (agent: string, session: string, event: unknown) => Promise<void> | void;

let injectedChatTurnDeps: ChatTurnDeps | null = null;
let injectedPublishEvent: PublishEvent | null = null;

/** Server boot wires runChatTurn deps + the SSE publisher here — same
 *  pattern as configureSentinel. publishEvent is mandatory-by-lesson
 *  (feedback_publishsse_must_broadcast): without it a wake turn lands
 *  in the JSONL but open clients only see it after a reload. */
export function configureTmuxAttention(args: {
  chatTurnDeps: ChatTurnDeps;
  publishEvent?: PublishEvent;
}): void {
  injectedChatTurnDeps = args.chatTurnDeps;
  if (args.publishEvent) injectedPublishEvent = args.publishEvent;
}

/** How many pane lines the watcher inspects per tick. The markers all
 *  live in the TUI footer, 50 lines is generous. */
const CAPTURE_LINES = 50;

function wakePrompt(name: string, kind: string): string {
  return (
    `[tmux attention] Session '${name}' (${kind}) became ready — it was running and is now idle, ` +
    `which means it finished or is waiting for input (e.g. a permission prompt). You started this ` +
    `session earlier and your last look predates this. Inspect it now:\n` +
    `1. Use the tmux tool (action: capture, name: "${name}") to read the output.\n` +
    `2. Decide: reply into the session, handle a prompt, report the result to the user, or wrap up.\n` +
    `Do not blindly send a new prompt — read first.`
  );
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  const list = await tmuxLocalList();
  return list.ok && list.sessions.some((s) => s.name === name);
}

export class TmuxAttentionWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly states = new Map<string, AttentionSessionState>();
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

  private watchedOrigins(liveNames: Set<string>): TmuxOrigin[] {
    return listTmuxOrigins().filter(
      (o) =>
        (o.kind === 'claude-code' || o.kind === 'codex') &&
        o.attention !== false &&
        liveNames.has(o.name),
    );
  }

  private async tickInner(): Promise<void> {
    // Live session names — dead sessions drop out of the state map so
    // a recreated same-name session starts from a fresh baseline.
    const list = await tmuxLocalList();
    if (!list.ok) return; // tmux server not running — nothing to watch
    const liveNames = new Set(
      list.sessions.map((s) => s.name),
    );
    for (const known of [...this.states.keys()]) {
      if (!liveNames.has(known)) this.states.delete(known);
    }

    const watched = this.watchedOrigins(liveNames);
    if (watched.length === 0) {
      this.mirror(); // clears stale entries when the last session dies
      return;
    }

    const observations = readTmuxObservations();
    const now = Date.now();

    for (const origin of watched) {
      const cap = await tmuxLocalCapture({ name: origin.name, lines: CAPTURE_LINES });
      if (!cap.ok) continue; // session vanished mid-tick — next tick prunes it
      const tui = detectTuiState(cap.stdout, origin.kind);
      if (!tui) continue;

      const originRef = {
        agent: origin.agent,
        ...(origin.session ? { session: origin.session } : {}),
      };
      const busy =
        origin.session !== undefined
          ? getSessionLockStatus(origin.agent, origin.session).activeTurnId !== undefined
          : false;

      const prev = this.states.get(origin.name) ?? initialAttentionState();
      const { state, action } = stepAttention({
        state: prev,
        tuiState: tui.state,
        now,
        observation: observations[origin.name] ?? null,
        origin: originRef,
        originBusy: busy,
        config: this.config,
      });
      this.states.set(origin.name, state);

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
          origin: originRef,
          wakesToday: state.wakesToday,
        });
        this.dispatchWake(origin);
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
  private dispatchWake(origin: TmuxOrigin): void {
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
    const publishSse = injectedPublishEvent
      ? (event: unknown) => injectedPublishEvent!(origin.agent, session, event)
      : undefined;
    void (async () => {
      const release = await acquireSessionLock(origin.agent, session, { priority: 'agent' });
      try {
        // The lock wait can be long — the origin's own turn typically
        // holds it, and that turn is often the one that `tmux kill`s the
        // session once the work is done. Waking for a session that no
        // longer exists burns a turn and confuses the agent ("became
        // ready" → `tmux list` → 0). Re-check liveness AFTER the wait.
        if (!(await tmuxSessionExists(origin.name))) {
          logger.info({
            msg: 'tmux.attention_wake_stale',
            name: origin.name,
            origin: { agent: origin.agent, session },
            reason: 'session gone before wake turn could start',
          });
          return;
        }
        await runChatTurn({
          agent: origin.agent,
          session,
          text: wakePrompt(origin.name, origin.kind ?? 'shell'),
          fromSystem: 'tmux',
          deps,
          ...(publishSse ? { publishSse: publishSse as never } : {}),
        });
      } catch (err) {
        logger.warn({
          msg: 'tmux.attention_wake_failed',
          name: origin.name,
          err: (err as Error).message,
        });
      } finally {
        release();
      }
    })();
  }
}

let watcher: TmuxAttentionWatcher | null = null;

export function startTmuxAttentionWatcher(config: TmuxAttentionConfig): void {
  if (watcher) return;
  watcher = new TmuxAttentionWatcher(config);
  watcher.start();
}

export function stopTmuxAttentionWatcher(): void {
  watcher?.stop();
  watcher = null;
}
