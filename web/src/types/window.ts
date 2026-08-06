// Window-manager state shapes. Phase 1 knows `kind: 'chat'`;
// Phase 1.5 adds `tmux-list` (the apps-dock entry, lists live tmux
// sessions) and `tmux-term` (an xterm.js attached to one specific
// session). Future kinds slot in by extending WindowKind.

export type WindowKind =
  | 'chat'
  | 'tmux-list'
  | 'tmux-term'
  | 'shell-term'
  | 'sessions-list'
  | 'sentinel'
  | 'pin-note'
  | 'file-view'
  | 'wiki'
  | 'tools';

/** A snapshot of an agent message that the user pinned for working-
 *  memory. Stored on the WindowState.payload of `kind: 'pin-note'`
 *  windows. Frozen at pin time — does not live-update with later
 *  streaming continuations. */
export interface PinNote {
  /** Source message id (from ChatProvider). Used for dedup + state-sync. */
  msgId: string;
  /** Markdown content snapshot. */
  text: string;
  agentName: string;
  agentIcon?: string;
  agentColor?: string;
  sessionId: string;
  /** Source session label used for the chat window's title. */
  sessionLabel?: string;
  /** Original message timestamp (ms epoch). */
  ts: number;
  /** Timestamp at which the pin itself was created (ms epoch). */
  pinnedAt: number;
}

/** A live window in the desktop's window manager. */
export interface WindowState {
  /** Unique id; stable across drags / focus changes / persistence. */
  id: string;
  kind: WindowKind;
  /** Title shown in the title bar (e.g. "<agent> · <session>"). */
  title: string;
  /** Optional small subtitle next to the title (e.g. "assistant"). */
  meta?: string;
  /** Optional emoji glyph rendered before the title. */
  icon?: string;
  // Chat-specific
  agentName?: string;
  sessionId?: string;
  // tmux-term specific — which tmux session this xterm is attached to.
  tmuxName?: string;
  // pin-note specific — the captured message snapshot.
  pinNote?: PinNote;
  // file-view specific — absolute path to the artefact being viewed.
  // The content is fetched lazily from /files/view on render so the
  // window state stays small (resumable from localStorage after a
  // reload without keeping the full body around).
  filePath?: string;
  // wiki specific — slug of the page the reader is on. Persisted so a
  // browser reload lands back on the same page instead of the tree root.
  wikiSlug?: string;
  // Geometry
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
}

/** Minimal slice persisted to localStorage so a browser reload
 *  restores the layout. The `windows` field is the source of truth;
 *  zCounter + focusedId live alongside so opening a new window after
 *  reload doesn't z-collide with restored ones. */
export interface PersistedLayout {
  windows: WindowState[];
  zCounter: number;
  focusedId: string | null;
}
