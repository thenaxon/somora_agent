// Window-manager state shapes. Phase 1 knows `kind: 'chat'`;
// Phase 1.5 adds `tmux-list` (the apps-dock entry, lists live tmux
// sessions) and `tmux-term` (an xterm.js attached to one specific
// session). Future kinds slot in by extending WindowKind.

export type WindowKind = 'chat' | 'tmux-list' | 'tmux-term' | 'shell-term' | 'sessions-list';

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
