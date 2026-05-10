// xterm.js attached to a fresh `$SHELL` PTY rooted in the somora
// workspace via /terminal/attach. One terminal per window — open
// multiple windows for parallel shells. Closing the window kills
// the shell.

import { XTermBridge } from './XTermBridge';

export function ShellTerminalWindow() {
  return <XTermBridge attachPath="/terminal/attach" busyLabel="shell" />;
}
