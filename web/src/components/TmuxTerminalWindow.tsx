// xterm.js attached to a `tmux attach-session -d -t <name>` PTY via
// /tmux/attach. Thin wrapper around XTermBridge — the rendering
// logic is shared with the plain-shell terminal window.

import { useCallback, useRef } from 'react';
import { api } from '../lib/api';
import { XTermBridge } from './XTermBridge';

interface Props {
  /** Tmux session name to attach to. Comes from the list-window's
   *  click handler via the window manager. */
  tmuxName: string;
}

export function TmuxTerminalWindow({ tmuxName }: Props) {
  // A session that ended (an agent's coordinator killed it) may be
  // started again under the same name: the open window attaches again.
  // Only a NEW session counts: tmux's id plus its start second (ids start
  // over when the tmux server restarts), as the server reported it on
  // attach. The same session still there means another client took it
  // over (attach detaches the others); attaching back would make two
  // windows throw each other out every few seconds. A listing that comes
  // back empty or fails decides nothing — only another identity does.
  const identity = (id: unknown, created: unknown) => `${typeof id === 'string' ? id : ''}@${typeof created === 'number' ? created : ''}`;
  const attached = useRef<string | null>(null);
  const onAttached = useCallback((msg: Record<string, unknown>) => {
    attached.current = identity(msg.sessionId, msg.createdEpoch);
  }, []);
  const isBack = useCallback(
    () =>
      api.tmuxSessions().then((list) => {
        const s = list.find((x) => x.name === tmuxName);
        return !!s && identity(s.sessionId, s.createdEpoch) !== attached.current;
      }),
    [tmuxName],
  );
  return (
    <XTermBridge
      attachPath={`/tmux/attach?session=${encodeURIComponent(tmuxName)}`}
      busyLabel="tmux attach"
      isBack={isBack}
      onAttached={onAttached}
    />
  );
}
