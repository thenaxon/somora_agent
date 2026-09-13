// One presentation table for system-originated inbounds.
//
// A user_message that no person and no peer agent wrote — a sentinel
// fire, a tmux wake, a browser hand-back, a voice consult, a late
// agent answer, a finished sub-agent, a rendered video — renders as a
// divider, not a bubble. This table says which glyph, label and
// subtitle each kind gets; the components in web (MessageItem) and
// web-mobile (ChatArea) only draw what it returns. Adding a kind is a
// row here, not a seventh hand-written component.
//
// Shared by both clients: web-mobile imports this file directly
// (../../../web/src/lib/origin.ts). Pure — no React, no DOM.
//
// Source of truth is `origin` (structured, since 2026-09-13). Turns
// recorded before that carry only `from_system`, and the subtitle then
// comes from the regexes the old dividers used over the message text.

import type { FromSystem, TurnOrigin } from '../types/origin';

/** The divider row a message maps to. `subagent` here is the WAKE
 *  ("your sub-agent finished"), not a sub-agent's own session. */
export type OriginRowKind = 'sentinel' | 'tmux' | 'browser' | 'voice' | 'a2a' | 'subagent' | 'job';

export interface OriginPresentation {
  /** Which row matched — components pick their icon set by this. */
  kind: OriginRowKind;
  /** Emoji fallback glyph (mobile draws it as-is; web maps kind → lucide). */
  glyph: string;
  /** Short label: "sentinel", "tmux", "agent answer", … */
  label: string;
  /** One-line detail next to the label; may be empty. */
  subtitle: string;
  /** Small secondary detail (a call id, a task id) — optional. */
  detail?: string;
  /** Accessible name for the divider element. */
  ariaLabel: string;
  /** The message text with the `[marker]` lead-in stripped — what a
   *  reader wants when expanding the divider. */
  body: string;
}

export interface OriginPresentationInput {
  origin?: TurnOrigin | undefined;
  fromSystem?: string | undefined;
  fromAgent?: string | undefined;
  text: string;
}

const VOICE_SUBTITLE_CHARS = 80;

/** Strip the `[sentinel trigger fired]`-style lead-in the server writes
 *  for the model; it is scaffolding, not something a reader needs. */
export function stripOriginMarker(text: string): string {
  return text.replace(/^\[[^\]]*\]\s*/, '').trim();
}

/** Browser view id → the name a person knows: `agent:naxon` → `naxon`,
 *  `profile:work` → `profile work`. */
function browserViewName(viewId: string): string {
  return viewId.replace(/^agent:/, '').replace(/^profile:/, 'profile ');
}

// --- legacy text regexes (turns without `origin`) -------------------

/** `[Sentinel trigger fired]\ntrigger_id: …\nname: <name>` → name. */
export function sentinelNameFromText(text: string): string {
  return text.match(/^name:\s*(.+)$/im)?.[1]?.trim() ?? '';
}

/** `[tmux attention] Session '<name>' (…` → name. */
export function tmuxSessionFromText(text: string): string {
  return text.match(/Session '([^']+)'/)?.[1] ?? '';
}

/** `[browser] … browser 'agent:naxon' …` → `naxon`. */
export function browserNameFromText(text: string): string {
  return browserViewName(text.match(/browser '([^']+)'/)?.[1] ?? '');
}

/** `[subagent attention] Task 'task_x' …` → task_x. */
export function subagentTaskFromText(text: string): string {
  return text.match(/Task '([^']+)'/)?.[1] ?? '';
}

/** `[agent answer] <agent> has answered …` → agent. */
export function agentAnswerWhoFromText(text: string): string {
  return /^\[agent answer\]\s*(\w+)/.exec(text)?.[1] ?? '';
}

/** First line after the `[video]` marker. */
export function videoLineFromText(text: string): string {
  return stripOriginMarker(text).split('\n')[0]?.trim() ?? '';
}

// --- the table ------------------------------------------------------

/** Which divider row a `from_system` word selects. */
function rowFromLegacy(fromSystem: string | undefined): OriginRowKind | null {
  switch (fromSystem) {
    case 'sentinel':
    case 'tmux':
    case 'browser':
    case 'voice':
    case 'a2a':
    case 'subagent':
    case 'job':
      return fromSystem;
    default:
      return null;
  }
}

/** Which divider row a structured origin selects. Human, peer-agent
 *  and a sub-agent's own brief are bubbles, not dividers → null. */
function rowFromOrigin(origin: TurnOrigin): OriginRowKind | null {
  switch (origin.kind) {
    case 'sentinel':
    case 'tmux':
    case 'browser':
    case 'voice':
      return origin.kind;
    case 'wake':
      return origin.about;
    default:
      return null;
  }
}

/**
 * Glyph, label and subtitle for a system-originated inbound, or null
 * when the message is a normal bubble (a person, a peer agent, a
 * sub-agent's own brief).
 *
 * `origin` wins when present; `fromSystem` is the fallback for turns
 * recorded before the server sent origins. A message from a peer
 * agent (`fromAgent`) is never a divider, whatever else it carries.
 */
export function originPresentation(msg: OriginPresentationInput): OriginPresentation | null {
  if (msg.fromAgent) return null;
  const origin = msg.origin;
  const kind = origin ? rowFromOrigin(origin) : rowFromLegacy(msg.fromSystem);
  if (!kind) return null;
  const text = msg.text ?? '';
  const body = stripOriginMarker(text);

  switch (kind) {
    case 'sentinel':
      // The origin carries only the trigger id; the name a person
      // recognises is on the prompt's `name:` line.
      return {
        kind,
        glyph: '🔔',
        label: 'Sentinel',
        subtitle: sentinelNameFromText(text),
        ...(origin?.kind === 'sentinel' ? { detail: origin.triggerId } : {}),
        ariaLabel: 'Sentinel trigger',
        body,
      };
    case 'tmux': {
      const subtitle =
        origin?.kind === 'tmux'
          ? origin.tmuxSession + (origin.tmuxKind ? ` · ${origin.tmuxKind}` : '')
          : tmuxSessionFromText(text);
      return { kind, glyph: '🖥', label: 'tmux', subtitle, ariaLabel: 'tmux attention wake', body };
    }
    case 'browser': {
      let subtitle: string;
      if (origin?.kind === 'browser') {
        const name = browserViewName(origin.viewId);
        const cause = origin.cause === 'activity' ? 'activity' : 'handed back';
        subtitle = name ? `${name} · ${cause}` : cause;
      } else {
        const name = browserNameFromText(text);
        // Old texts: a handoff id in the prompt means the person handed
        // it back on request; otherwise they took over and did things.
        const cause = /handoff [a-z0-9]/i.test(text) ? 'handed back' : 'handed back after your changes';
        subtitle = name ? `${name} · ${cause}` : cause;
      }
      return { kind, glyph: '🌐', label: 'browser', subtitle, ariaLabel: 'browser hand-back wake', body };
    }
    case 'voice':
      return {
        kind,
        glyph: '🎙',
        label: 'voice',
        subtitle: body.length > VOICE_SUBTITLE_CHARS ? `${body.slice(0, VOICE_SUBTITLE_CHARS)}…` : body,
        ...(origin?.kind === 'voice' ? { detail: origin.consultId } : {}),
        ariaLabel: 'voice channel question',
        body,
      };
    case 'a2a':
      return {
        kind,
        glyph: '↩',
        label: 'agent answer',
        subtitle: agentAnswerWhoFromText(text),
        ...(origin?.kind === 'wake' ? { detail: origin.ref } : {}),
        ariaLabel: 'answer from an agent you asked',
        body,
      };
    case 'subagent':
      return {
        kind,
        glyph: '🤖',
        label: 'subagent',
        subtitle: origin?.kind === 'wake' && origin.ref ? origin.ref : subagentTaskFromText(text),
        ariaLabel: 'subagent finished',
        body,
      };
    case 'job':
      return {
        kind,
        glyph: '🎬',
        label: 'video',
        subtitle: videoLineFromText(text),
        ...(origin?.kind === 'wake' ? { detail: origin.ref } : {}),
        ariaLabel: 'video render finished',
        body,
      };
  }
}

/** Every legacy `from_system` word, for type widening at the edges. */
export const FROM_SYSTEM_VALUES: readonly FromSystem[] = [
  'sentinel',
  'tmux',
  'subagent',
  'job',
  'browser',
  'voice',
  'a2a',
];
