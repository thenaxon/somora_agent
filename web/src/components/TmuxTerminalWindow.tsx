// xterm.js attached to a `tmux attach-session -d -t <name>` PTY via
// /tmux/attach. Thin wrapper around XTermBridge — the rendering
// logic is shared with the plain-shell terminal window.

import { XTermBridge } from './XTermBridge';

interface Props {
  /** Tmux session name to attach to. Comes from the list-window's
   *  click handler via the window manager. */
  tmuxName: string;
}

export function TmuxTerminalWindow({ tmuxName }: Props) {
  return (
    <XTermBridge
      attachPath={`/tmux/attach?session=${encodeURIComponent(tmuxName)}`}
      busyLabel="tmux attach"
    />
  );
}
