// RescanLoop (no overlap, quiet when nothing changed, stop) and the
// watcher retry policy. Run: npx tsx src/memory/rescan.test.mts
import { isTransientWatcherError, RescanLoop, watcherRetryDelayMs } from './rescan.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── RescanLoop ──
{
  let runs = 0;
  let release: (() => void) | undefined;
  const loop = new RescanLoop({
    intervalMs: 30,
    run: async () => {
      runs++;
      await new Promise<void>((r) => (release = r));
      return { indexed: 0, skipped: 3 };
    },
    logCtx: { agent: 'test' },
  });
  loop.start();
  await sleep(45);
  check('first tick started a sweep', runs === 1 && loop.isRunning, `runs=${runs}`);
  await sleep(70);
  check('ticks while a sweep runs are no-ops', runs === 1, `runs=${runs}`);
  const overlap = await loop.runNow();
  check('runNow during a sweep returns null', overlap === null);
  release!();
  await sleep(50);
  check('after the sweep ends the next tick runs again', runs >= 2, `runs=${runs}`);
  loop.stop();
  const before = runs;
  release?.();
  await sleep(80);
  check('stopped: no further ticks', runs === before || runs === before + 0, `runs=${runs} before=${before}`);
}
{
  const loop = new RescanLoop({ intervalMs: 0, run: async () => ({ indexed: 0, skipped: 0 }) });
  loop.start();
  check('interval 0 never starts', !loop.isRunning);
  loop.stop();
}
{
  const loop = new RescanLoop({ intervalMs: 60_000, run: async () => { throw new Error('EHOSTDOWN: host is down'); } });
  const r = await loop.runNow();
  check('a failing sweep is reported as zero, not thrown', r !== null && r.indexed === 0 && !loop.isRunning);
}

// ── retry policy ──
check('EHOSTDOWN is transient', isTransientWatcherError(Object.assign(new Error('x'), { code: 'EHOSTDOWN' })));
check('a stringified scandir error is transient', isTransientWatcherError('Error: EHOSTDOWN: host is down, scandir /mnt/x'));
check('ENOENT (share not mounted yet) is transient', isTransientWatcherError(Object.assign(new Error('x'), { code: 'ENOENT' })));
check('EACCES is not', !isTransientWatcherError(Object.assign(new Error('x'), { code: 'EACCES' })));
check('a plain bug is not', !isTransientWatcherError(new TypeError('undefined is not a function')));
check('delays grow 30 s → 60 s → 2 min … capped at 10 min', watcherRetryDelayMs(1) === 30_000 && watcherRetryDelayMs(2) === 60_000 && watcherRetryDelayMs(3) === 120_000 && watcherRetryDelayMs(6) === 600_000 && watcherRetryDelayMs(40) === 600_000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
