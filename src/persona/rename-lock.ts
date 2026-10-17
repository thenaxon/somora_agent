// While an agent is being renamed (rename.ts), nothing new may start for
// it: its folder moves and its files are rewritten underneath whatever
// runs. The rename holds both names — the old one, and the new one, whose
// folder must not appear before the move. Every turn takes a session lock
// (session-queue.ts) and every session write makes the sessions folder
// (storage/sessions.ts); both ask here first and are refused while the
// name is held. The hold is taken in the same synchronous step as the
// rename's busy check, so nothing slips in between.
//
// No imports: the session store and the session queue both depend on it.

const held = new Set<string>();

export class AgentRenamingError extends Error {
  constructor(agent: string) {
    super(`agent '${agent}' is being renamed — try again in a moment`);
    this.name = 'AgentRenamingError';
  }
}

export function isRenaming(agent: string): boolean {
  return held.has(agent);
}

export function assertNotRenaming(agent: string): void {
  if (held.has(agent)) throw new AgentRenamingError(agent);
}

/** Hold the names; the returned function lets go. */
export function holdForRename(names: string[]): () => void {
  for (const n of names) held.add(n);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const n of names) held.delete(n);
  };
}
