/** One snapshot in flight, one dirty bit: slow readers cannot build a queue.
 * Subscribe before the first read; repeat if a change crossed that read. */
export function watchBrowserSnapshots<T>(args: {
  subscribe: (changed: () => void) => () => void;
  read: () => Promise<T>;
  send: (snapshot: T) => Promise<void>;
  failed: (error: unknown) => void;
}): () => void {
  let stopped = false;
  let busy = false;
  let dirty = false;
  const changed = () => {
    dirty = true;
    if (busy || stopped) return;
    busy = true;
    void (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false;
          const snapshot = await args.read();
          if (!stopped) await args.send(snapshot);
        }
      } catch (error) {
        if (!stopped) args.failed(error);
      } finally { busy = false; }
    })();
  };
  const unsubscribe = args.subscribe(changed);
  changed();
  return () => { stopped = true; unsubscribe(); };
}
